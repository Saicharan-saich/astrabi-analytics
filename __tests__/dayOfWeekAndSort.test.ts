/**
 * Fix #2: "total revenue by day of the week, highest to lowest".
 *  (a) "highest to lowest" must sort DESC (it contains "lowest" — the old code
 *      returned ASC).
 *  (b) A native DayOfWeek column must be used directly, not derived from the date
 *      column, and no spurious date filter applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { detectRankingDirection, enforceNativeCyclicDimension } from '../services/ai-sql/intentPlanner';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

const ORDERS = [
    { OrderID: 1, OrderDate: '2025-06-05', DayOfWeek: 'Saturday', TotalPrice: 100 },
    { OrderID: 2, OrderDate: '2025-06-06', DayOfWeek: 'Saturday', TotalPrice: 50 },
    { OrderID: 3, OrderDate: '2025-06-07', DayOfWeek: 'Monday', TotalPrice: 30 },
    { OrderID: 4, OrderDate: '2025-06-08', DayOfWeek: 'Monday', TotalPrice: 20 },
    { OrderID: 5, OrderDate: '2025-06-09', DayOfWeek: 'Friday', TotalPrice: 70 },
];

let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(ORDERS, 'orders.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'orders', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const gen = (p: any) => normalizeSQLForDuckDB(correctSQL(p as AnalysisPlan, model));
const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(v));
const P = (o: any): any => ({ intent: 'breakdown', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o });

describe('detectRankingDirection — compound phrases', () => {
    it('"highest to lowest" is DESC (not ASC)', () => {
        expect(detectRankingDirection('total revenue by day of the week, highest to lowest')).toBe('desc');
        expect(detectRankingDirection('sort high to low')).toBe('desc');
        expect(detectRankingDirection('descending order')).toBe('desc');
    });
    it('"lowest to highest" is ASC', () => {
        expect(detectRankingDirection('lowest to highest')).toBe('asc');
        expect(detectRankingDirection('ascending')).toBe('asc');
    });
});

describe('enforceNativeCyclicDimension — use the DayOfWeek column', () => {
    it('replaces a date-grain dimension + strips date filters', () => {
        const plan = P({
            dimensions: [{ field: 'order_date', timeGrain: 'day_of_week' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
            filters: [{ field: 'order_date', op: 'between', value: ['2025-06-29', '2025-07-05'] }],
        });
        enforceNativeCyclicDimension(plan, 'total revenue by day of the week, highest to lowest', model);
        expect(plan.dimensions).toEqual([{ field: 'day_of_week' }]);
        expect(plan.filters).toHaveLength(0); // spurious date filter removed
    });
});

describe('end-to-end: revenue by day of week, highest to lowest', () => {
    it('groups by day_of_week (not the date column) and sums revenue correctly', () => {
        const plan = P({
            dimensions: [{ field: 'day_of_week' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        });
        const sql = gen(plan).toUpperCase();
        expect(sql).toContain('GROUP BY');
        expect(sql).toContain('DAY_OF_WEEK');
        expect(sql).not.toContain('DAYNAME');       // uses the native column, not date derivation
        expect(sql).not.toContain('ORDER_DATE');     // and never the date column
        const res = duck.query(gen(plan));
        const byDay: Record<string, number> = {};
        for (const r of res) byDay[String(r.day_of_week)] = num(r.total_price_sum);
        expect(byDay).toEqual({ Saturday: 150, Monday: 50, Friday: 70 });
    });
});
