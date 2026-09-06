import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { sanitizeDashboard } from '../shared/dashboardPrivacy.mjs';
import { dashboardFixture } from './helpers/dashboardFixture';
const require = createRequire(import.meta.url);
const { saveDashboard, scrubStoredDashboardResults, sanitizeStoredDashboards } = require('../backend/dashboardPersistence.js');

describe('dashboard data boundary', () => {
    it('preserves PostgreSQL timestamps when removing historical result payloads', async () => {
        const [clean] = await sanitizeStoredDashboards([{
            ...dashboardFixture(), created_at: new Date('2026-09-06T12:00:00Z'),
            updated_at: new Date('2026-09-06T13:00:00Z'),
        }]);
        expect(clean.created_at).toBe('2026-09-06T12:00:00.000Z');
        expect(clean.updated_at).toBe('2026-09-06T13:00:00.000Z');
        expect(JSON.stringify(clean)).not.toContain('PRIVATE_');
    });
    it('removes all result values while retaining replay and layout settings without mutating local data', () => {
        const original = dashboardFixture();
        original.items[0].rawData = [{ secret: 'PRIVATE_FILE' }];
        original.items[0].result.queryConfig.unexpected = { data: ['PRIVATE_NESTED'] };
        original.items[0].result.formatting.image = 'PRIVATE_IMAGE';
        const clean = sanitizeDashboard(original);
        expect(JSON.stringify(clean)).not.toContain('PRIVATE_');
        expect(JSON.stringify(clean)).not.toContain('998877');
        expect(JSON.stringify(clean)).not.toContain('887766');
        expect(clean.items[0].result).toMatchObject({ data: [], needsLocalData: true, insight: '' });
        expect(clean.items[0].result.sql).toBe(original.items[0].result.sql);
        expect(clean.items[0].result.queryConfig.metric).toBe('sales');
        expect(clean.items[0].result.formatting.tableCalculations).toEqual(['percent_of_total']);
        expect(clean.layout).toEqual(original.layout);
        expect(clean.filters).toEqual(original.filters);
        expect(original.items[0].result.data).toHaveLength(175);
        expect(sanitizeDashboard(clean)).toEqual(clean);
    });
    it('preserves AI SQL comparison recipes but excludes nested chart growth and unknown results', () => {
        const original = dashboardFixture();
        original.items[0].result.aiSqlRefresh = {
            version: 1, source: 'ai-sql', question: 'Compare sales', sql: 'SELECT sales FROM data',
            plan: {
                intent: 'total_comparison', dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }],
                filters: [{ field: 'region', op: 'in', value: ['North'] }],
                comparison: { type: 'previous_period', mode: 'total' }, sort: [], limit: null,
                ambiguous: false, resultGrain: 'summary', originalQuestion: 'Compare sales',
                rawData: ['PRIVATE_PLAN'],
            },
            chart: { chartType: 'groupedBar', xKey: 'Metric', yKey: 'Value', useDualAxis: false,
                growth: { diff: 776655 }, reason: 'PRIVATE_CHART' },
        };
        const clean = sanitizeDashboard(original);
        expect(JSON.stringify(clean)).not.toMatch(/PRIVATE_|776655/);
        expect(clean.items[0].result.aiSqlRefresh.plan.comparison.mode).toBe('total');
        expect(clean.items[0].result.aiSqlRefresh.plan.filters[0].value).toEqual(['North']);
    });
});

// Execute the production UPSERT against an actual SQL engine. This covers
// ownership/collision semantics, not merely a mocked successful database call.
describe('dashboard persistence ownership and historical cleanup', () => {
    let db: any;
    let pool: any;
    beforeAll(async () => {
        const SQL = await initSqlJs({ locateFile: file => path.resolve('node_modules/sql.js/dist', file) });
        db = new SQL.Database();
        db.create_function('NOW', () => '2026-09-06T12:00:00Z');
        db.run('CREATE TABLE dashboards (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT, dataset_id TEXT, items TEXT, layout TEXT, filters TEXT, formatting TEXT, updated_at TEXT)');
        pool = { query: async (sql: string, params: any[] = []) => {
            const stmt = db.prepare(sql);
            try {
                stmt.bind(Object.fromEntries(params.map((p, i) => ['$' + (i + 1), p])));
                const rows: any[] = [];
                while (stmt.step()) rows.push(stmt.getAsObject());
                return { rows, rowCount: rows.length || db.getRowsModified() };
            } finally { stmt.free(); }
        } };
    });
    afterAll(() => db?.close());
    it('allows the owner to update and rejects another account using the same ID', async () => {
        const input = dashboardFixture();
        expect((await saveDashboard(pool, 'alice', input)).status).toBe(200);
        expect((await saveDashboard(pool, 'bob', { ...input, name: 'Overwrite attempt' })).status).toBe(409);
        expect((await saveDashboard(pool, 'alice', { ...input, name: 'Owner update' })).status).toBe(200);
        const { rows } = await pool.query('SELECT * FROM dashboards WHERE id=$1', [input.id]);
        expect(rows[0].user_id).toBe('alice');
        expect(rows[0].name).toBe('Owner update');
        expect(rows[0].items).not.toContain('PRIVATE_');
    });
    it('keeps separate IDs independent and rejects malformed IDs', async () => {
        expect((await saveDashboard(pool, 'bob', { ...dashboardFixture(), id: 'dashboard-b' })).status).toBe(200);
        expect((await saveDashboard(pool, 'bob', { ...dashboardFixture(), id: {} })).status).toBe(400);
    });
    it('scrubs stored result rows without deleting historical dashboard definitions', async () => {
        const input = dashboardFixture();
        await pool.query('UPDATE dashboards SET items=$1 WHERE id=$2', [JSON.stringify(input.items), input.id]);
        const migrationPool = { query: async (sql: string, params: any[]) => {
            const res = await pool.query(sql, params);
            if (sql.startsWith('SELECT')) res.rows = res.rows.map((row: any) => ({
                ...row, ...Object.fromEntries(['items', 'layout', 'filters', 'formatting'].map(key => [key, JSON.parse(row[key])])),
            }));
            return res;
        } };
        await scrubStoredDashboardResults(migrationPool);
        const { rows } = await pool.query('SELECT * FROM dashboards WHERE id=$1', [input.id]);
        expect(rows).toHaveLength(1);
        expect(rows[0].name).toBe('Owner update');
        expect(rows[0].items).not.toContain('PRIVATE_');
        expect(JSON.parse(rows[0].items)[0].result.sql).toBe(input.items[0].result.sql);
    });
});
