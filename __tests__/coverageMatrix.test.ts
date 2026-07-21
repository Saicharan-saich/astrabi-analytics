/**
 * Coverage matrix — the "prove it's deterministic" gate.
 * ─────────────────────────────────────────────────────────────────────
 * A taxonomy of descriptive + diagnostic question shapes. Each asserts it
 * resolves to a DETERMINISTIC path — the Question Builder engine, the anti-join
 * knob, or the deterministic correction engine — and, for the builder cases,
 * returns the correct answer against DuckDB. The final assertion pins the overall
 * deterministic coverage so a regression that drops a shape to the LLM fails CI.
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
import { buildValueCatalog } from '../services/ai-sql/valueGrounding';
import { detectAntiJoin, buildAntiJoinSQL } from '../services/ai-sql/antiJoin';
import { CORRECTION_ENGINE_INTENTS } from '../services/ai-sql/qbKnobCatalog';
import type { AnalysisPlan } from '../services/ai-sql/types';

const ROWS = [
    { order_id: 1, customer_id: 'C1', channel: 'Delivery', category: 'Food', product: 'Burger', quantity: 2, unit_price: 10, total_price: 20, order_date: '2025-01-05' },
    { order_id: 2, customer_id: 'C1', channel: 'Delivery', category: 'Food', product: 'Pizza', quantity: 1, unit_price: 15, total_price: 15, order_date: '2025-01-20' },
    { order_id: 3, customer_id: 'C2', channel: 'Dine-In', category: 'Beverage', product: 'Latte', quantity: 3, unit_price: 5, total_price: 15, order_date: '2025-02-10' },
    { order_id: 4, customer_id: 'C3', channel: 'Delivery', category: 'Retail', product: 'Mug', quantity: 1, unit_price: 8, total_price: 8, order_date: '2025-02-15' },
    { order_id: 5, customer_id: 'C4', channel: 'Online', category: 'Food', product: 'Burger', quantity: 2, unit_price: 10, total_price: 20, order_date: '2025-03-01' },
    { order_id: 6, customer_id: 'C2', channel: 'Dine-In', category: 'Food', product: 'Pizza', quantity: 1, unit_price: 15, total_price: 15, order_date: '2025-03-12' },
];

let duck: DuckHandle, model: any, catalog: any;
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(ROWS, 'orders.csv');
    model = buildSemanticModel({ id: 't', name: 'orders', rows: etl.rows, columns: etl.columns, totalRows: etl.rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', etl.rows);
    catalog = buildValueCatalog(etl.rows, model);
}, 60000);
afterAll(() => duck?.close());

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'breakdown', dimensions: [], metrics: [], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});
const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(v));

type Tier = 'qb' | 'antijoin' | 'correction';
interface Case { label: string; question: string; plan: AnalysisPlan; tier: Tier; check?: (rows: any[]) => void; }

const scalarIs = (n: number) => (rows: any[]) => expect(num(Object.values(rows[0])[0])).toBe(n);

const CASES: Case[] = [
    { label: 'total (sum)', question: 'total revenue', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }] }), tier: 'qb', check: scalarIs(93) },
    { label: 'count', question: 'how many orders', plan: P({ intent: 'single_metric', metrics: [{ field: '*', agg: 'count' }] }), tier: 'qb', check: scalarIs(6) },
    { label: 'count distinct', question: 'distinct customers', plan: P({ intent: 'single_metric', metrics: [{ field: 'customer_id', agg: 'count_distinct' }] }), tier: 'qb', check: scalarIs(4) },
    { label: 'median', question: 'median order value', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'avg' }], originalQuestion: 'median order value' }), tier: 'qb', check: scalarIs(15) },
    { label: 'filter =', question: 'revenue from Delivery', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'channel', op: '=', value: 'Delivery' }] }), tier: 'qb', check: scalarIs(43) },
    { label: 'exclude !=', question: 'revenue excluding Delivery', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'channel', op: '!=', value: 'Delivery' }] }), tier: 'qb', check: scalarIs(50) },
    { label: 'LIKE', question: 'revenue for products like Burger', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'product', op: 'like', value: 'Burger' }] }), tier: 'qb', check: scalarIs(40) },
    { label: 'above avg (rows)', question: 'orders above the average order value', plan: P({ intent: 'aggregate_filter', metrics: [{ field: '*', agg: 'count' }], filters: [{ field: 'total_price', op: 'above_avg', value: null }] }), tier: 'qb', check: scalarIs(2) },
    { label: 'breakdown', question: 'revenue by channel', plan: P({ intent: 'breakdown', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }] }), tier: 'qb', check: (r) => expect(r.length).toBe(3) },
    { label: 'ranking top-1', question: 'top product by revenue', plan: P({ intent: 'ranking', dimensions: [{ field: 'product' }], metrics: [{ field: 'total_price', agg: 'sum' }], sort: [{ field: 'total_price', dir: 'desc' }], limit: 1 }), tier: 'qb', check: (r) => expect(String(r[0].product)).toBe('Burger') },
    { label: 'trend', question: 'revenue by month', plan: P({ intent: 'trend', dimensions: [{ field: 'order_date', timeGrain: 'month' }], metrics: [{ field: 'total_price', agg: 'sum' }] }), tier: 'qb', check: (r) => expect(r.length).toBe(3) },
    { label: 'distribution', question: 'distribution of order values', plan: P({ intent: 'distribution', metrics: [{ field: 'total_price', agg: 'sum' }] }), tier: 'qb', check: (r) => expect(r.reduce((s: number, x: any) => s + num(x.count), 0)).toBe(6) },
    { label: 'correlation', question: 'revenue vs quantity by category', plan: P({ intent: 'correlation', dimensions: [{ field: 'category' }], metrics: [{ field: 'total_price', agg: 'sum' }, { field: 'quantity', agg: 'sum' }] }), tier: 'qb' },
    { label: 'share of total', question: 'share of revenue by channel', plan: P({ intent: 'share_of_total', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }] }), tier: 'qb' },
    { label: 'grouped above avg', question: 'customers above the average customer', plan: P({ intent: 'aggregate_filter', dimensions: [{ field: 'customer_id' }], metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'total_price', op: 'above_avg', value: null, isHaving: true }] }), tier: 'qb', check: (r) => expect(r.map((x: any) => String(x.customer_id)).sort()).toEqual(['C1', 'C2']) },
    { label: 'anti-join', question: 'customers who bought Burger but never Pizza', plan: P({ intent: 'breakdown', dimensions: [{ field: 'customer_id' }] }), tier: 'antijoin', check: (r) => expect(r.map((x: any) => String(x.customer_id))).toEqual(['C4']) },
    { label: 'period comparison', question: 'revenue this month vs last month', plan: P({ intent: 'total_comparison', metrics: [{ field: 'total_price', agg: 'sum' }], comparison: { type: 'previous_period', mode: 'total' } }), tier: 'correction' },
    { label: 'two-stage derived', question: 'average daily sales', plan: P({ intent: 'derived_metric', metrics: [{ field: 'total_price', agg: 'avg', derivedMetricId: 'avg_daily' }] }), tier: 'correction' },
    { label: 'contribution / mix-shift', question: 'what drove the change in revenue by channel', plan: P({ intent: 'total_comparison', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }], comparison: { type: 'previous_period', mode: 'total' } }), tier: 'correction' },
    { label: 'numeric row filter', question: 'orders over $15', plan: P({ intent: 'single_metric', metrics: [{ field: '*', agg: 'count' }], filters: [{ field: 'total_price', op: '>', value: 15 }] }), tier: 'qb', check: scalarIs(2) },
];

function runQb(plan: AnalysisPlan): any[] {
    const res = mapPlanToQBConfig(plan, model);
    if (!res.fits) throw new Error(`expected QB fit: ${(res as any).reason}`);
    const qp = buildQueryPlan(res.config, res.dateColumnKey, getDates('2025-03-12'), 'data');
    let rows = duck.query(compileSQL(qp));
    if (res.shareOfTotal && qp.metrics[0]) rows = applyTableCalculation(rows, qp.metrics[0].alias, 'percent_of_total', qp.metrics[0].alias, 'raw', 'pct').transformedData;
    return rows;
}

describe('coverage matrix — descriptive + diagnostic', () => {
    for (const c of CASES) {
        it(`${c.label}: deterministic (${c.tier})`, () => {
            if (c.tier === 'qb') {
                expect(mapPlanToQBConfig(c.plan, model).fits).toBe(true);
                if (c.check) c.check(runQb(c.plan));
            } else if (c.tier === 'antijoin') {
                const spec = detectAntiJoin(c.question, catalog, model);
                expect(spec).not.toBeNull();
                if (c.check) c.check(duck.query(buildAntiJoinSQL(spec!, 'data')));
            } else {
                // correction-engine: not a base-builder fit, but a deterministic intent.
                expect(mapPlanToQBConfig(c.plan, model).fits).toBe(false);
                expect(CORRECTION_ENGINE_INTENTS.has(c.plan.intent)).toBe(true);
            }
        });
    }

    it('every taxonomy shape is deterministic (0 routed to the LLM)', () => {
        const nonDeterministic = CASES.filter(c => {
            if (c.tier === 'qb') return !mapPlanToQBConfig(c.plan, model).fits;
            if (c.tier === 'antijoin') return detectAntiJoin(c.question, catalog, model) === null;
            return !CORRECTION_ENGINE_INTENTS.has(c.plan.intent);
        });
        expect(nonDeterministic.map(c => c.label)).toEqual([]);
    });
});
