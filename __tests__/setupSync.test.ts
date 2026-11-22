/**
 * Saved cleaning setups kept with the account: only choices and column names
 * are stored, the newest version wins, and deletions travel both ways.
 */
import { describe, expect, it } from 'vitest';
import { planSync } from '../utils/cleaningSetups';
import type { CleaningSetup } from '../types';

const { cleanSetup, withoutRows, createCleaningSetupService } = require('../backend/cleaningSetups.js');

const setup = (id: string, updatedAt: number, extra: Partial<CleaningSetup> = {}): CleaningSetup => ({
    id, name: `Setup ${id}`, createdAt: 1, updatedAt, headers: ['Order ID', 'Revenue'],
    columns: [{ name: 'order_id', type: 'ID' as any }, { name: 'revenue', type: 'METRIC' as any }],
    etlOptions: { blankDecisions: { revenue: 'zero' } }, ...extra,
});

describe('setups stored with the account', () => {
    it('keep choices and column names, and drop anything that could carry rows', () => {
        const stored = cleanSetup({
            ...setup('setup_a1', 5),
            rows: [{ revenue: 1 }],
            etlOptions: { manualSteps: [{ id: 's', kind: 'filter_rows', column: 'customer', op: 'contains', value: 'test' }], sampleRows: [{ secret: 'Jane' }], nested: { rawRows: [{ x: 1 }], stepBase: { rows: [] } } },
            columns: [{ name: 'revenue', type: 'METRIC' }, { name: 'bad', type: 'NOT_A_KIND' }],
            columnTypes: { revenue: 'METRIC', other: 'WRONG' },
        });
        expect(stored).not.toHaveProperty('rows');
        expect(JSON.stringify(stored)).not.toMatch(/Jane|rawRows|stepBase|sampleRows/);
        expect(stored.etlOptions.manualSteps[0].value).toBe('test');
        expect(stored.columns).toEqual([{ name: 'revenue', type: 'METRIC' }]);
        expect(stored.columnTypes).toEqual({ revenue: 'METRIC' });
        expect(withoutRows({ a: { __x: 1, b: [{ rows: [1] }] } })).toEqual({ a: { b: [{}] } });
    });

    it('refuse things that are not setups, or are too large', () => {
        expect(cleanSetup(null)).toBeNull();
        expect(cleanSetup({ ...setup('bad id!', 1) })).toBeNull();
        expect(cleanSetup({ ...setup('ok', 1), name: '   ' })).toBeNull();
        const huge = setup('big', 1, { etlOptions: { customRules: Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}`, column: 'c'.repeat(150), test: 'x'.repeat(150), action: 'flag' })) as any } });
        expect(cleanSetup(huge)).toBeNull();
    });

    it('save only when newer, and leave a marker when deleted', async () => {
        const calls: { sql: string; params: any[] }[] = [];
        const pool = { query: async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return { rows: /COUNT/.test(sql) ? [{ n: 0 }] : [], rowCount: 1 }; } };
        const service = createCleaningSetupService({ getPool: () => pool });
        const saved = await service.save('u1', setup('setup_a1', 50));
        expect(saved.status).toBe(200);
        const insert = calls.find(c => /INSERT INTO cleaning_setups/.test(c.sql))!;
        expect(insert.sql).toMatch(/WHERE cleaning_setups.updated_ms <= EXCLUDED.updated_ms/);
        expect(insert.params.slice(0, 2)).toEqual(['u1', 'setup_a1']);
        expect((await service.save('u1', { id: 'x' })).status).toBe(400);
        expect((await service.remove('u1', 'setup_a1', 99)).status).toBe(200);
        const marker = calls.find(c => /deleted = true/.test(c.sql))!;
        expect(marker.params).toEqual(['u1', 'setup_a1', 99]);
        // Once deleted, it stops reaching the accounts it was shared with.
        expect(calls.at(-1)!.sql).toMatch(/DELETE FROM cleaning_setup_shares/);
        expect((await service.remove('u1', 'no good', 1)).status).toBe(400);
    });
});

describe('syncing this browser with the account', () => {
    it('keeps the newest version of each setup and pushes what the account lacks', () => {
        const plan = planSync(
            [setup('a', 10, { name: 'Here newer' }), setup('b', 5), setup('local-only', 3)],
            {},
            { setups: [setup('a', 8, { name: 'There older' }), setup('b', 7, { name: 'There newer' }), setup('remote-only', 4)], deleted: [] },
        );
        expect(plan.keep.map(s => `${s.id}:${s.name}`).sort()).toEqual(['a:Here newer', 'b:There newer', 'local-only:Setup local-only', 'remote-only:Setup remote-only']);
        expect(plan.push.map(s => s.id).sort()).toEqual(['a', 'local-only']);
        expect(plan.remove).toEqual([]);
    });

    it('carries deletions both ways, but a newer edit survives an older deletion', () => {
        const plan = planSync(
            [setup('gone-there', 5), setup('edited-after', 20)],
            { 'gone-here': 30 },
            { setups: [setup('gone-here', 10)], deleted: [{ id: 'gone-there', at: 9 }, { id: 'edited-after', at: 15 }] },
        );
        expect(plan.keep.map(s => s.id)).toEqual(['edited-after']);
        expect(plan.push.map(s => s.id)).toEqual(['edited-after']);
        expect(plan.remove).toEqual([{ id: 'gone-here', at: 30 }]);
    });

    it('sends usage counts when the setup itself did not change', () => {
        const plan = planSync([setup('a', 10, { timesUsed: 3 })], {}, { setups: [setup('a', 10, { timesUsed: 1 })], deleted: [] });
        expect(plan.push.map(s => s.timesUsed)).toEqual([3]);
    });
});
