/**
 * An engineer (admin) saves a setup on the client's computer and shares it
 * with the client's own login; the client receives it read-only.
 */
import { describe, expect, it } from 'vitest';
import type { CleaningSetup } from '../types';

const { createCleaningSetupService, registerCleaningSetupRoutes } = require('../backend/cleaningSetups.js');

/** Just enough of Postgres for the setup service's queries. */
function fakePool(users: { id: string; name: string }[]) {
    const setups = new Map<string, { user_id: string; id: string; setup: any; updated_ms: number; deleted: boolean }>();
    const shares: { owner_id: string; setup_id: string; user_id: string }[] = [];
    const key = (u: string, id: string) => `${u}|${id}`;
    return {
        setups, shares,
        async query(sql: string, p: any[] = []) {
            if (/^\s*CREATE/.test(sql)) return { rows: [] };
            if (sql.includes('SELECT COUNT(*)')) return { rows: [{ n: [...setups.values()].filter(s => s.user_id === p[0] && !s.deleted).length }] };
            if (sql.includes('INSERT INTO cleaning_setups')) {
                const deleted = /VALUES \(\$1, \$2, '\{\}', \$3, true/.test(sql);
                const prev = setups.get(key(p[0], p[1]));
                const at = deleted ? p[2] : p[3];
                if (prev && prev.updated_ms > at) return { rows: [], rowCount: 0 };
                setups.set(key(p[0], p[1]), { user_id: p[0], id: p[1], setup: deleted ? {} : JSON.parse(p[2]), updated_ms: at, deleted });
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SELECT id, setup, updated_ms, deleted FROM cleaning_setups')) return { rows: [...setups.values()].filter(s => s.user_id === p[0]) };
            if (sql.includes('SELECT setup_id, user_id FROM cleaning_setup_shares')) return { rows: shares.filter(s => s.owner_id === p[0]) };
            if (sql.includes('SELECT 1 FROM cleaning_setups')) return { rows: setups.get(key(p[0], p[1]))?.deleted === false ? [{}] : [] };
            if (sql.includes('SELECT id FROM users')) return { rows: users.filter(u => p[0].includes(u.id)).map(u => ({ id: u.id })) };
            if (sql.includes('DELETE FROM cleaning_setup_shares')) { for (let i = shares.length - 1; i >= 0; i--) if (shares[i].owner_id === p[0] && shares[i].setup_id === p[1]) shares.splice(i, 1); return { rows: [] }; }
            if (sql.includes('INSERT INTO cleaning_setup_shares')) { shares.push({ owner_id: p[0], setup_id: p[1], user_id: p[2] }); return { rows: [] }; }
            if (sql.includes('FROM cleaning_setup_shares s')) {
                return { rows: shares.filter(s => s.user_id === p[0]).map(s => ({ s, c: setups.get(key(s.owner_id, s.setup_id)) })).filter(x => x.c && !x.c.deleted)
                    .map(x => ({ setup: x.c!.setup, owner_name: users.find(u => u.id === x.s.owner_id)?.name })) };
            }
            throw new Error(`unexpected query: ${sql}`);
        },
    };
}

const setup = (id: string, updatedAt: number): CleaningSetup => ({
    id, name: 'Acme monthly orders', createdAt: 1, updatedAt, headers: ['Order ID', 'Revenue'],
    columns: [{ name: 'order_id', type: 'ID' as any }, { name: 'revenue', type: 'METRIC' as any }], etlOptions: { blankDecisions: { revenue: 'zero' } },
});

describe('sharing a cleaning setup with the client', () => {
    const people = [{ id: 'eng', name: 'Priya (data team)' }, { id: 'client', name: 'Acme Ltd' }, { id: 'other', name: 'Other Co' }];

    it('reaches only the accounts the admin picked, in its latest version, until it is deleted', async () => {
        const pool = fakePool(people);
        const service = createCleaningSetupService({ getPool: () => pool });
        await service.save('eng', setup('setup_acme', 10));
        expect((await service.setShares('eng', 'setup_acme', ['client'])).status).toBe(200);
        expect((await service.list('eng')).shares).toEqual({ setup_acme: ['client'] });

        const received = await service.sharedWith('client');
        expect(received.setups.map((s: any) => [s.id, s.sharedBy])).toEqual([['setup_acme', 'Priya (data team)']]);
        expect((await service.sharedWith('other')).setups).toEqual([]);

        await service.save('eng', { ...setup('setup_acme', 20), name: 'Acme orders v2' });
        expect((await service.sharedWith('client')).setups[0].name).toBe('Acme orders v2');

        await service.remove('eng', 'setup_acme', 30);
        expect((await service.sharedWith('client')).setups).toEqual([]);
        expect(pool.shares).toEqual([]);
    });

    it('refuses setups not saved yet, missing accounts and bad lists', async () => {
        const pool = fakePool(people);
        const service = createCleaningSetupService({ getPool: () => pool });
        expect((await service.setShares('eng', 'setup_none', ['client'])).status).toBe(404);
        await service.save('eng', setup('setup_b', 1));
        expect((await service.setShares('eng', 'setup_b', ['ghost'])).status).toBe(400);
        expect((await service.setShares('eng', 'setup_b', 'client')).status).toBe(400);
        expect((await service.setShares('eng', 'setup_b', ['eng', 'client', 'client'])).body.userIds).toEqual(['client']);
    });

    it('lets every role read what was shared with it, but only admins share', async () => {
        const routes: Record<string, Function[]> = {};
        const app = { get: (p: string, ...h: Function[]) => { routes[`GET ${p}`] = h; }, put: (p: string, ...h: Function[]) => { routes[`PUT ${p}`] = h; }, delete: (p: string, ...h: Function[]) => { routes[`DELETE ${p}`] = h; } };
        const service = { sharedWith: async (id: string) => ({ setups: [{ id: `for_${id}` }] }), setShares: async () => ({ status: 200, body: { success: true } }) };
        registerCleaningSetupRoutes(app, service, { requireAuthenticatedUser: (_q: any, _r: any, next: () => void) => next() });
        const run = async (route: string, role: string) => {
            const res: any = { code: 200, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
            const req: any = { authUser: { userId: 'u1', role }, params: { id: 'setup_b' }, body: { userIds: ['x'] }, query: {} };
            let i = 0; const next = async () => { const h = routes[route][i++]; if (h) await h(req, res, next); };
            await next();
            return res;
        };
        for (const role of ['contributor', 'viewer', 'admin']) {
            const res = await run('GET /api/cleaning-setups/shared', role);
            expect([role, res.code, res.body]).toEqual([role, 200, { setups: [{ id: 'for_u1' }] }]);
        }
        expect((await run('PUT /api/cleaning-setups/:id/shares', 'contributor')).code).toBe(403);
        expect((await run('PUT /api/cleaning-setups/:id/shares', 'admin')).code).toBe(200);
    });
});
