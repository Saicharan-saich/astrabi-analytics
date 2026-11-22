import { describe, expect, it } from 'vitest';
import { canUseCleaning } from '../utils/cleaningAccess';
import { UserRole } from '../types';
import { createGuestContributor } from '../services/guestAccessPolicy';
import setupRoutes from '../backend/cleaningSetups.js';

describe('cleaning is for admins only', () => {
    it('lets admins clean and nobody else', () => {
        expect(canUseCleaning({ role: UserRole.ADMIN })).toBe(true);
        expect(canUseCleaning({ role: UserRole.CONTRIBUTOR })).toBe(false);
        expect(canUseCleaning({ role: UserRole.VIEWER })).toBe(false);
        expect(canUseCleaning(createGuestContributor(1))).toBe(false);
        expect(canUseCleaning(null)).toBe(false);
        expect(canUseCleaning({ role: 'admin' })).toBe(true);
    });

    it('refuses the setup routes to anyone but an admin', async () => {
        const routes: Record<string, Function[]> = {};
        const app = { get: (p: string, ...h: Function[]) => { routes[`GET ${p}`] = h; }, put: (p: string, ...h: Function[]) => { routes[`PUT ${p}`] = h; }, delete: (p: string, ...h: Function[]) => { routes[`DELETE ${p}`] = h; } };
        const calls: string[] = [];
        const service = { list: async () => { calls.push('list'); return { setups: [] }; }, save: async () => ({ status: 200, body: {} }), remove: async () => ({ status: 200, body: {} }) };
        const requireAuthenticatedUser = (_req: any, _res: any, next: () => void) => next();
        setupRoutes.registerCleaningSetupRoutes(app, service, { requireAuthenticatedUser });
        expect(Object.keys(routes).sort()).toEqual(['DELETE /api/cleaning-setups/:id', 'GET /api/cleaning-setups', 'GET /api/cleaning-setups/shared', 'PUT /api/cleaning-setups/:id', 'PUT /api/cleaning-setups/:id/shares']);
        const run = async (key: string, role: string) => {
            const res: any = { code: 200, body: undefined, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
            const req: any = { authUser: { userId: 'u1', role }, params: { id: 's1' }, body: { id: 's1' }, query: {} };
            const chain = routes[key];
            let i = 0;
            const next = async () => { const h = chain[i++]; if (h) await h(req, res, next); };
            await next();
            return res;
        };
        // Reading what was shared with you is open to every role (see setupSharing.test.ts).
        for (const key of Object.keys(routes).filter(k => k !== 'GET /api/cleaning-setups/shared')) {
            for (const role of ['contributor', 'viewer']) {
                const res = await run(key, role);
                expect([key, role, res.code, res.body]).toEqual([key, role, 403, { error: 'Cleaning setups are for admins only' }]);
            }
        }
        expect(calls).toEqual([]);
        expect((await run('GET /api/cleaning-setups', 'admin')).code).toBe(200);
        expect(calls).toEqual(['list']);
    });
});
