/**
 * Engine improvement: infer revenue = unit price × quantity.
 *
 * Reproduces the reported failure "total revenue for each product category",
 * where a dataset has `price` + `units_sold` but NO explicit revenue column, and
 * the engine wrongly answered SUM(price) instead of SUM(price * units_sold).
 * The governed `computed_revenue` composite + the deterministic keyword override
 * fix it — independent of the LLM.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { buildCompositeMetrics } from '../services/ai-sql/metricRegistry';
import { enforceCompositeMetrics } from '../services/ai-sql/intentPlanner';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

const PRODUCTS = [
    { product_id: 1, product_name: 'Widget', category: 'Hardware', price: 25, units_sold: 400 },
    { product_id: 2, product_name: 'Gadget', category: 'Hardware', price: 60, units_sold: 150 },
    { product_id: 3, product_name: 'Cloud Plan', category: 'Software', price: 120, units_sold: 300 },
    { product_id: 4, product_name: 'Support Pack', category: 'Software', price: 40, units_sold: 220 },
    { product_id: 5, product_name: 'Cable', category: 'Hardware', price: 8, units_sold: 900 },
];

let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(PRODUCTS, 'products.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'product', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const P = (o: any): any => ({ intent: 'breakdown', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'scalar', originalQuestion: '', ...o });

describe('buildCompositeMetrics — computed_revenue synthesis', () => {
    it('adds Revenue = price × quantity when there is no revenue column', () => {
        const rev = buildCompositeMetrics(model.fields).find((m: any) => m.id === 'computed_revenue');
        expect(rev, 'computed_revenue composite should exist for a price+quantity dataset').toBeTruthy();
        expect(rev!.formula.replace(/\s+/g, '')).toMatch(/SUM\((price\*units_sold|units_sold\*price)\)/i);
        expect(rev!.synonyms).toContain('revenue');
    });

    it('does NOT synthesize it when an explicit revenue column exists', () => {
        const withRevenue = [
            { name: 'unit_price', role: 'metric', semanticType: 'currency', defaultAgg: 'sum', synonyms: [] },
            { name: 'quantity', role: 'metric', semanticType: 'quantity', defaultAgg: 'sum', synonyms: [] },
            { name: 'revenue', role: 'metric', semanticType: 'currency', defaultAgg: 'sum', synonyms: [] },
        ] as any;
        expect(buildCompositeMetrics(withRevenue).find((m: any) => m.id === 'computed_revenue')).toBeUndefined();
    });
});

describe('enforceCompositeMetrics — "revenue" question forces the governed formula', () => {
    it('rewrites a SUM(price) plan into the computed_revenue composite', () => {
        const plan = P({ dimensions: [{ field: 'category' }], metrics: [{ field: 'price', agg: 'sum' }] });
        enforceCompositeMetrics(plan, 'total revenue for each product category', model);
        expect(plan.metrics).toHaveLength(1);
        expect(plan.metrics[0].compositeId).toBe('computed_revenue');
    });

    it('the specific "revenue per customer" composite wins over generic revenue', () => {
        // When a real revenue_per_customer ratio exists, "revenue per customer"
        // must map to it, not to the generic computed_revenue total.
        const twoComposites = {
            compositeMetrics: [
                { id: 'revenue_per_customer', dependsOn: ['revenue', 'customer_id'], formula: 'x' },
                { id: 'computed_revenue', dependsOn: ['price', 'qty'], formula: 'y' },
            ],
        } as any;
        const plan = P({ metrics: [{ field: 'price', agg: 'sum' }] });
        enforceCompositeMetrics(plan, 'what is the revenue per customer', twoComposites);
        expect(plan.metrics[0].compositeId).toBe('revenue_per_customer');
    });
});

describe('end-to-end: revenue by category yields the correct totals', () => {
    it('SUM(price*units_sold) GROUP BY category = Hardware 26200, Software 44800', () => {
        const plan = P({ dimensions: [{ field: 'category' }], metrics: [{ field: 'price', agg: 'sum' }] });
        enforceCompositeMetrics(plan, 'what is the total revenue for each product category', model);
        const sql = normalizeSQLForDuckDB(correctSQL(plan as AnalysisPlan, model));
        expect(sql.replace(/\s+/g, '')).toMatch(/price\*units_sold|units_sold\*price/i);

        const res = duck.query(sql);
        const byCat: Record<string, number> = {};
        for (const r of res) {
            const cat = String(r.category);
            const val = num(Object.values(r).find((v, i) => Object.keys(r)[i] !== 'category'));
            byCat[cat] = val;
        }
        expect(byCat['Hardware']).toBe(26200);
        expect(byCat['Software']).toBe(44800);
    });
});
