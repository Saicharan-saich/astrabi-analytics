/**
 * QB Mapper — AI SQL's primary compilation target.
 *
 * Proves two things:
 *  1. FIT cases: a plan that lands on real builder knobs is mapped to a
 *     UIQueryConfig, compiled via buildQueryPlan → compileSQL, and returns the
 *     correct answer from DuckDB.
 *  2. NO-FIT cases: a plan needing a shape the builder has no knob for is
 *     refused (fits:false) with a reason — so the pipeline falls back to AI SQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { mapPlanToQBConfig } from '../services/ai-sql/qbMapper';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { getDates } from '../services/dateHelpers';
import { applyTableCalculation } from '../utils/tableCalculations';
import type { AnalysisPlan } from '../services/ai-sql/types';

const ROWS = [
    { order_id: 1, customer_id: 'C1', channel: 'Delivery', category: 'Food', product: 'Burger', quantity: 2, unit_price: 10, total_price: 20, order_date: '2025-01-05' },
    { order_id: 2, customer_id: 'C1', channel: 'Delivery', category: 'Food', product: 'Pizza', quantity: 1, unit_price: 15, total_price: 15, order_date: '2025-01-20' },
    { order_id: 3, customer_id: 'C2', channel: 'Dine-In', category: 'Beverage', product: 'Latte', quantity: 3, unit_price: 5, total_price: 15, order_date: '2025-02-10' },
    { order_id: 4, customer_id: 'C3', channel: 'Delivery', category: 'Retail', product: 'Mug', quantity: 1, unit_price: 8, total_price: 8, order_date: '2025-02-15' },
    { order_id: 5, customer_id: 'C4', channel: 'Online', category: 'Food', product: 'Burger', quantity: 2, unit_price: 10, total_price: 20, order_date: '2025-03-01' },
    { order_id: 6, customer_id: 'C2', channel: 'Dine-In', category: 'Food', product: 'Pizza', quantity: 1, unit_price: 15, total_price: 15, order_date: '2025-03-12' },
];

let duck: DuckHandle, model: any;
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(ROWS, 'orders.csv');
    model = buildSemanticModel({ id: 't', name: 'orders', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', etl.rows);
}, 60000);
afterAll(() => duck?.close());

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'breakdown', dimensions: [], metrics: [], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});

/** Map a plan → QB config → SQL, run it, return rows. Fails loudly on no-fit. */
function runQB(plan: AnalysisPlan): Record<string, any>[] {
    const res = mapPlanToQBConfig(plan, model);
    if (!res.fits) throw new Error(`expected fit, got no-fit: ${(res as { reason?: string }).reason}`);
    const dates = getDates(model.timeContext?.anchorDate || '2025-03-12');
    const qp = buildQueryPlan(res.config, res.dateColumnKey, dates, 'data');
    let rows = duck.query(compileSQL(qp));
    if (res.shareOfTotal && qp.metrics[0]) {
        rows = applyTableCalculation(rows, qp.metrics[0].alias, 'percent_of_total', qp.metrics[0].alias, 'raw', 'pct_of_total').transformedData;
    }
    return rows;
}
const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(v));
const scalar = (rows: Record<string, any>[]) => num(Object.values(rows[0])[0]);

describe('QB mapper — FIT cases produce correct answers', () => {
    it('single_metric: total revenue = 93', () => {
        expect(scalar(runQB(P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }] })))).toBe(93);
    });

    it('single_metric with filter: Delivery revenue = 43', () => {
        const rows = runQB(P({
            intent: 'single_metric',
            metrics: [{ field: 'total_price', agg: 'sum' }],
            filters: [{ field: 'channel', op: '=', value: 'Delivery' }],
        }));
        expect(scalar(rows)).toBe(43);
    });

    it('count_distinct with filter: distinct Delivery customers = 2 (not 3 rows)', () => {
        const rows = runQB(P({
            intent: 'single_metric',
            metrics: [{ field: 'customer_id', agg: 'count_distinct' }],
            filters: [{ field: 'channel', op: '=', value: 'Delivery' }],
        }));
        expect(scalar(rows)).toBe(2);
    });

    it('breakdown: revenue by channel', () => {
        const rows = runQB(P({
            intent: 'breakdown',
            dimensions: [{ field: 'channel' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        }));
        const by: Record<string, number> = {};
        // ETL normalizes casing on categorical values (Dine-In → Dine-in); the
        // grouping/aggregation is what matters here.
        for (const r of rows) by[String(r.channel).toLowerCase()] = num(r.sum_total_price);
        expect(by).toEqual({ delivery: 43, 'dine-in': 30, online: 20 });
    });

    it('ranking: top product by revenue is Burger (40), limited to 1', () => {
        const rows = runQB(P({
            intent: 'ranking',
            dimensions: [{ field: 'product' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
            sort: [{ field: 'total_price', dir: 'desc' }],
            limit: 1,
        }));
        expect(rows).toHaveLength(1);
        expect(String(rows[0].product)).toBe('Burger');
        expect(num(rows[0].sum_total_price)).toBe(40);
    });

    it('trend: revenue by month is chronological', () => {
        const rows = runQB(P({
            intent: 'trend',
            dimensions: [{ field: 'order_date', timeGrain: 'month' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        }));
        const months = rows.map(r => String(r.time_month));
        expect(months).toEqual(['2025-01', '2025-02', '2025-03']);
    });

    it('COUNT(*): total order count = 6', () => {
        const rows = runQB(P({
            intent: 'single_metric',
            metrics: [{ field: '*', agg: 'count' }],
        }));
        expect(scalar(rows)).toBe(6);
    });

    it('share_of_total: revenue share by channel sums to 100% with correct splits', () => {
        // Total revenue = 93; Delivery 43, Dine-in 30, Online 20.
        const rows = runQB(P({
            intent: 'share_of_total',
            dimensions: [{ field: 'channel' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        }));
        const by: Record<string, number> = {};
        for (const r of rows) by[String(r.channel).toLowerCase()] = num(r.pct_of_total);
        expect(by.delivery).toBeCloseTo(4300 / 93, 4);
        expect(by['dine-in']).toBeCloseTo(3000 / 93, 4);
        expect(by.online).toBeCloseTo(2000 / 93, 4);
        const total = Object.values(by).reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(100, 4);
    });
});

describe('QB mapper — NO-FIT cases fall back to AI SQL', () => {
    const noFit = (plan: AnalysisPlan) => {
        const r = mapPlanToQBConfig(plan, model);
        expect(r.fits).toBe(false);
        return (r as { reason?: string }).reason || '';
    };

    it('above-average filter has no builder knob', () => {
        expect(noFit(P({
            intent: 'aggregate_filter',
            metrics: [{ field: 'total_price', agg: 'sum' }],
            filters: [{ field: 'total_price', op: 'above_avg', value: null }],
        }))).toMatch(/advanced engine|not a builder/i);
    });

    it('scalar (filtered, no-dimension) share needs the advanced engine', () => {
        expect(noFit(P({
            intent: 'share_of_total',
            metrics: [{ field: 'total_price', agg: 'sum' }],
            filters: [{ field: 'category', op: '=', value: 'Beverage' }],
        }))).toMatch(/advanced engine/i);
    });

    it('period comparison is not a base knob', () => {
        expect(noFit(P({
            intent: 'breakdown', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }],
            comparison: { type: 'previous_period', mode: 'total' },
        }))).toMatch(/comparison/i);
    });

    it('derived (two-stage) metric is not a single aggregation', () => {
        expect(noFit(P({ intent: 'derived_metric', metrics: [{ field: 'total_price', agg: 'avg', derivedMetricId: 'avg_daily' }] }))).toMatch(/advanced engine|derived/i);
    });

    it('LIKE / NOT_IN filters are not builder options', () => {
        expect(noFit(P({ intent: 'breakdown', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'product', op: 'like', value: '%Burg%' }] }))).toMatch(/not a builder option/i);
        expect(noFit(P({ intent: 'breakdown', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'channel', op: 'not_in', value: ['Online'] }] }))).toMatch(/not a builder option/i);
    });
});
