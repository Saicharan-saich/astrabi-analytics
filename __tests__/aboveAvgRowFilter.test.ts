/**
 * Engine fix: "which products have a price above the average product price?" is a
 * ROW-LEVEL projection, not a GROUP BY … HAVING aggregate. Reproduces the exact
 * benchmark case end-to-end (plan → correctSQL → DuckDB) and checks it matches
 * the gold, while the analytical "above-average TOTAL" case stays on HAVING.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

/** Order-insensitive row-set equality — enough to check a result matches gold. */
function sameRows(a: Record<string, any>[], b: Record<string, any>[]): boolean {
    const norm = (rows: Record<string, any>[]) => rows
        .map(r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]])))
        .sort();
    const [x, y] = [norm(a), norm(b)];
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

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
    const etl = runETLPipeline(PRODUCTS, 'product.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'product', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
    duck.loadTable('product', PRODUCTS);
}, 60000);
afterAll(() => duck?.close());

const gen = (p: any) => normalizeSQLForDuckDB(correctSQL(p as AnalysisPlan, model));
const P = (o: any): any => ({ intent: 'aggregate_filter', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o });

describe('row-level above-average attribute → projection (matches gold)', () => {
    it('SELECT product_name WHERE price > (SELECT AVG(price)) — no GROUP BY', () => {
        const plan = P({
            dimensions: [{ field: 'product_name' }],
            metrics: [{ field: 'price', agg: 'avg' }],
            filters: [{ field: 'price', op: 'above_avg', value: null }],
        });
        const sql = gen(plan).toUpperCase();
        expect(sql).toContain('WHERE');
        expect(sql).toContain('SELECT AVG');
        expect(sql).not.toContain('GROUP BY');
        expect(sql).not.toContain('HAVING');

        const got = duck.query(gen(plan));
        const gold = duck.query('SELECT product_name FROM product WHERE price > (SELECT AVG(price) FROM product)');
        expect(sameRows(gold, got)).toBe(true);
        // Sanity: Gadget (60) and Cloud Plan (120) are above the mean price (50.6).
        expect(got.map((r: any) => r.product_name).sort()).toEqual(['Cloud Plan', 'Gadget']);
    });

    it('below-average uses "<"', () => {
        const plan = P({
            dimensions: [{ field: 'product_name' }],
            metrics: [{ field: 'price', agg: 'avg' }],
            filters: [{ field: 'price', op: 'below_avg', value: null }],
        });
        const got = duck.query(gen(plan));
        const gold = duck.query('SELECT product_name FROM product WHERE price < (SELECT AVG(price) FROM product)');
        expect(sameRows(gold, got)).toBe(true);
    });
});

describe('analytical "above-average TOTAL" stays on the HAVING path', () => {
    it('SUM aggregation keeps GROUP BY + HAVING (not rewritten to a row filter)', () => {
        const plan = P({
            intent: 'aggregate_filter',
            dimensions: [{ field: 'category' }],
            metrics: [{ field: 'units_sold', agg: 'sum' }],
            filters: [{ field: 'units_sold', op: 'above_avg', value: null, isHaving: true }],
        });
        const sql = gen(plan).toUpperCase();
        expect(sql).toContain('GROUP BY');
        expect(sql).toContain('HAVING');
    });
});
