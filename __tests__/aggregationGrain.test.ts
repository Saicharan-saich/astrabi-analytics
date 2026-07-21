/**
 * Fix #3: over-grouping. "Which time of day has the highest average order value?"
 * was grouped by time_of_day + order_date + order_id, collapsing the aggregate to
 * one order. enforceAggregationGrain drops id / raw-date grouping dimensions when
 * a real categorical dimension remains — but keeps date dimensions that carry a
 * time grain (intentional time breakdowns).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { enforceAggregationGrain } from '../services/ai-sql/intentPlanner';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

const ORDERS = [
    { OrderID: 1, OrderDate: '2025-06-05', TimeOfDay: 'Breakfast', TotalPrice: 30 },
    { OrderID: 2, OrderDate: '2025-06-06', TimeOfDay: 'Breakfast', TotalPrice: 20 },
    { OrderID: 3, OrderDate: '2025-06-07', TimeOfDay: 'Lunch', TotalPrice: 10 },
    { OrderID: 4, OrderDate: '2025-06-08', TimeOfDay: 'Lunch', TotalPrice: 12 },
    { OrderID: 5, OrderDate: '2025-06-09', TimeOfDay: 'Dinner', TotalPrice: 8 },
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
const fieldOf = (d: any) => d.field;
const P = (o: any): any => ({ intent: 'ranking', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o });

describe('enforceAggregationGrain', () => {
    it('drops id + raw-date dimensions, keeps the categorical one', () => {
        const plan = P({
            dimensions: [{ field: 'time_of_day' }, { field: 'order_date' }, { field: 'order_id' }],
            metrics: [{ field: 'total_price', agg: 'avg' }],
        });
        enforceAggregationGrain(plan, model);
        expect(plan.dimensions.map(fieldOf)).toEqual(['time_of_day']);
    });

    it('keeps a date dimension that has a time grain (intentional time breakdown)', () => {
        const plan = P({
            intent: 'trend',
            dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'time_of_day' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        });
        enforceAggregationGrain(plan, model);
        expect(plan.dimensions.map(fieldOf).sort()).toEqual(['order_date', 'time_of_day']);
    });

    it('leaves a legitimate two-categorical breakdown untouched', () => {
        const plan = P({
            intent: 'breakdown',
            dimensions: [{ field: 'time_of_day' }],
            metrics: [{ field: 'total_price', agg: 'sum' }],
        });
        enforceAggregationGrain(plan, model);
        expect(plan.dimensions.map(fieldOf)).toEqual(['time_of_day']);
    });
});

describe('end-to-end: time of day with the highest average order value', () => {
    it('groups only by time_of_day → Breakfast is the top average (25)', () => {
        const plan = P({
            dimensions: [{ field: 'time_of_day' }, { field: 'order_date' }, { field: 'order_id' }],
            metrics: [{ field: 'total_price', agg: 'avg' }],
        });
        enforceAggregationGrain(plan, model);
        const res = duck.query(gen(plan));
        const byTod: Record<string, number> = {};
        for (const r of res) byTod[String(r.time_of_day)] = num(r.total_price_avg);
        expect(byTod).toEqual({ Breakfast: 25, Lunch: 11, Dinner: 8 });
        // The highest average is Breakfast — the intended answer.
        const top = Object.entries(byTod).sort((a, b) => b[1] - a[1])[0][0];
        expect(top).toBe('Breakfast');
    });
});
