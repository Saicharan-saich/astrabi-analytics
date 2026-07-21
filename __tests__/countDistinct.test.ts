/**
 * Fix: "How many distinct customers ordered via Delivery?" produced COUNT(*)
 * (rows) instead of COUNT(DISTINCT customer). Now "distinct/unique <entity>" is
 * detected and the entity noun is resolved to its id column. End-to-end.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { detectExplicitAggregation, applyCountSemantics } from '../services/ai-sql/intentPlanner';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

const ORDERS = [
    { OrderID: 1, CustomerID: 'C1', RestaurantType: 'Delivery', TotalPrice: 10 },
    { OrderID: 2, CustomerID: 'C1', RestaurantType: 'Delivery', TotalPrice: 20 }, // same customer
    { OrderID: 3, CustomerID: 'C2', RestaurantType: 'Delivery', TotalPrice: 30 },
    { OrderID: 4, CustomerID: 'C3', RestaurantType: 'Dine-In', TotalPrice: 40 },
    { OrderID: 5, CustomerID: 'C4', RestaurantType: 'Delivery', TotalPrice: 50 },
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
const P = (o: any): any => ({ intent: 'single_metric', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'scalar', originalQuestion: '', ...o });

describe('detectExplicitAggregation — distinct/unique', () => {
    it('maps "how many distinct/unique X" to count_distinct', () => {
        expect(detectExplicitAggregation('how many distinct customers ordered via delivery')).toBe('count_distinct');
        expect(detectExplicitAggregation('number of unique customers')).toBe('count_distinct');
        expect(detectExplicitAggregation('count of distinct servers')).toBe('count_distinct');
    });
    it('plain "how many" stays a plain count', () => {
        expect(detectExplicitAggregation('how many orders are there')).toBe('count');
    });
});

describe('applyCountSemantics resolves the entity noun to its id column', () => {
    it('"distinct customers" → COUNT(DISTINCT customer_id)', () => {
        const plan = P({ metrics: [{ field: '*', agg: 'count' }], filters: [{ field: 'restaurant_type', op: '=', value: 'Delivery' }] });
        const handled = applyCountSemantics('count_distinct', plan, model, 'how many distinct customers ordered via delivery');
        expect(handled).toBe(true);
        expect(plan.metrics).toEqual([{ field: 'customer_id', agg: 'count_distinct' }]);
    });
});

describe('end-to-end: distinct customers via Delivery', () => {
    it('COUNT(DISTINCT customer_id) WHERE restaurant_type=Delivery = 3, not COUNT(*)=4', () => {
        const plan = P({ metrics: [{ field: 'customer_id', agg: 'count_distinct' }], filters: [{ field: 'restaurant_type', op: '=', value: 'Delivery' }] });
        const sql = gen(plan);
        expect(sql.toUpperCase()).toContain('COUNT(DISTINCT');
        const got = num(Object.values(duck.query(sql)[0])[0]);
        expect(got).toBe(3);  // C1, C2, C4 — distinct delivery customers (not 4 rows)
    });
});
