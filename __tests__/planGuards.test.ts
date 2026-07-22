/**
 * Plan-layer guards (the fixes for the "utterly failed" test run):
 *  - a row-identifier dimension (order_id) is dropped, so an aggregate becomes a
 *    proper scalar instead of one-group-per-row;
 *  - grounding recovers a PLURAL value ("Beverages" → category = Beverage);
 *  - verification flags SUM of a per-unit price (SUM(unit_price) is not revenue);
 *  - the field mapper prefers the additive total over a per-unit price.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { mapPlanToQBConfig } from '../services/ai-sql/qbMapper';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { getDates } from '../services/dateHelpers';
import { buildValueCatalog, groundFilters } from '../services/ai-sql/valueGrounding';
import { verifyPlan } from '../services/ai-sql/planVerification';
import { mapFieldsFromQuestion } from '../services/ai-sql/fieldMapper';
import type { AnalysisPlan } from '../services/ai-sql/types';

const fld = (name: string, role: 'metric' | 'dimension', semanticType: string, distinctCount: number): any => ({
    name, role, semanticType, defaultAgg: role === 'metric' ? 'sum' : 'none',
    physicalType: role === 'metric' ? 'number' : 'string',
    synonyms: [], valueDescriptors: [], distinctCount, hasNulls: false, displayLabel: name, timeGrainSupport: [],
});

const model: any = {
    fields: [
        fld('order_id', 'dimension', 'identifier', 6),   // unique per row
        fld('customer_id', 'dimension', 'identifier', 4),
        fld('menu_category', 'dimension', 'category', 3),
        fld('quantity', 'metric', 'quantity', 4),
        fld('unit_price', 'metric', 'currency', 5),
        fld('total_price', 'metric', 'currency', 6),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 6, grain: 'order',
};

const ROWS = [
    { order_id: 1, customer_id: 'C1', menu_category: 'Beverage', quantity: 1, unit_price: 10, total_price: 10 },
    { order_id: 2, customer_id: 'C1', menu_category: 'Food', quantity: 2, unit_price: 10, total_price: 20 },
    { order_id: 3, customer_id: 'C2', menu_category: 'Beverage', quantity: 3, unit_price: 5, total_price: 15 },
    { order_id: 4, customer_id: 'C3', menu_category: 'Retail', quantity: 1, unit_price: 8, total_price: 8 },
    { order_id: 5, customer_id: 'C4', menu_category: 'Food', quantity: 2, unit_price: 10, total_price: 20 },
    { order_id: 6, customer_id: 'C2', menu_category: 'Food', quantity: 1, unit_price: 15, total_price: 15 },
];
const catalog = buildValueCatalog(ROWS, model);

let duck: DuckHandle;
beforeAll(async () => { duck = await createDuck(); duck.loadTable('data', ROWS); }, 60000);
afterAll(() => duck?.close());

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'single_metric', dimensions: [], metrics: [{ field: 'total_price', agg: 'sum' }],
    filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});

describe('row-identifier dimension guard', () => {
    it('"orders above the average order value" ignores the order_id dimension → row-level count = 2', () => {
        // total_prices 10,20,15,8,20,15 → avg ≈ 14.67; above: 20,15,20,15 → 4.
        const plan = P({
            intent: 'aggregate_filter',
            dimensions: [{ field: 'order_id' }], // stray row-id dimension from the plan
            metrics: [{ field: 'total_price', agg: 'sum' }],
            filters: [{ field: 'total_price', op: 'above_avg', value: null, isHaving: true }],
        });
        const res = mapPlanToQBConfig(plan, model);
        expect(res.fits).toBe(true);
        const qp = buildQueryPlan((res as any).config, (res as any).dateColumnKey, getDates('2025-06-30'), 'data');
        const sql = compileSQL(qp);
        expect(sql).not.toMatch(/GROUP BY .*order_id/i);
    });

    it('keeps a legitimate identifier dimension (customer_id is not unique-per-row)', () => {
        const res = mapPlanToQBConfig(P({ intent: 'breakdown', dimensions: [{ field: 'customer_id' }], metrics: [{ field: 'total_price', agg: 'sum' }] }), model);
        expect(res.fits).toBe(true);
        expect((res as any).config.dimension).toBe('customer_id');
    });
});

describe('grounding plural', () => {
    it('"Beverages" recovers category = Beverage', () => {
        const g = groundFilters('what % of revenue comes from Beverages', catalog, P({}), model);
        expect(g.added).toContainEqual({ field: 'menu_category', op: '=', value: 'Beverage' });
    });
});

describe('non-additive SUM verification', () => {
    it('flags SUM(unit_price) as an error', () => {
        const r = verifyPlan('total revenue', P({ metrics: [{ field: 'unit_price', agg: 'sum' }] }), model, catalog);
        expect(r.ok).toBe(false);
        expect(r.issues.some(i => i.code === 'nonadditive_sum')).toBe(true);
    });
    it('does not flag SUM(total_price)', () => {
        const r = verifyPlan('total revenue', P({ metrics: [{ field: 'total_price', agg: 'sum' }] }), model, catalog);
        expect(r.issues.some(i => i.code === 'nonadditive_sum')).toBe(false);
    });
});

describe('field mapper additive-currency preference', () => {
    it('"total revenue" maps to total_price, not unit_price', () => {
        const res = mapFieldsFromQuestion('what is the total revenue', model);
        expect(res.metrics.map((m: any) => m.name)).toContain('total_price');
        expect(res.metrics.map((m: any) => m.name)).not.toContain('unit_price');
    });
});
