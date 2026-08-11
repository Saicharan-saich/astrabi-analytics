/**
 * Regression for the reported bug: "count of male patients whose age is above 50"
 * returned SUM(age) = 963,575 instead of COUNT(*). A count question counts ROWS;
 * a numeric field that only appears as a FILTER (age) must never be the metric.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import { applyCountSemantics } from '../services/ai-sql/intentPlanner';
import { validatePlan } from '../services/ai-sql/planValidator';
import type { AnalysisPlan } from '../services/ai-sql/types';

function patients(n = 500) {
    return Array.from({ length: n }, (_, i) => ({
        name: `P${i}`, gender: i % 2 ? 'Male' : 'Female', age: 18 + (i % 70),
        department: ['Cardiology', 'Oncology', 'Neurology'][i % 3],
        doctor: ['Dr A', 'Dr B', 'Dr C', 'Dr D'][i % 4],
        billing_amount: 500 + (i * 137) % 45000,
    }));
}

let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(patients(), 'p.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'patients', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const gen = (p: any) => normalizeSQLForDuckDB(correctSQL(p as AnalysisPlan, model));
const run = (p: any) => duck.query(gen(p));
const P = (o: any): any => ({ intent: 'single_metric', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'scalar', originalQuestion: '', ...o });

describe('applyCountSemantics — the plan-level fix', () => {
    it('THE BUG: rewrites a filter/attribute metric (age) to COUNT(*)', () => {
        const plan = P({ metrics: [{ field: 'age', agg: 'sum' }], filters: [{ field: 'gender', op: '=', value: 'Male' }, { field: 'age', op: '>', value: 50 }] });
        const handled = applyCountSemantics('count', plan, model);
        expect(handled).toBe(true);
        expect(plan.metrics).toEqual([{ field: '*', agg: 'count' }]);
        // filters are preserved — the answer is still restricted to Male + age>50
        expect(plan.filters).toHaveLength(2);
    });

    it('leaves non-count aggregations untouched', () => {
        const plan = P({ metrics: [{ field: 'billing_amount', agg: 'sum' }] });
        expect(applyCountSemantics('sum', plan, model)).toBe(false);
        expect(plan.metrics).toEqual([{ field: 'billing_amount', agg: 'sum' }]);
    });

    it('count_distinct of a named non-filter dimension → COUNT(DISTINCT dim)', () => {
        const plan = P({ dimensions: [{ field: 'doctor' }], metrics: [{ field: 'doctor', agg: 'count' }], filters: [] });
        applyCountSemantics('count_distinct', plan, model);
        expect(plan.metrics).toEqual([{ field: 'doctor', agg: 'count_distinct' }]);
        expect(plan.dimensions).toEqual([]);
    });

    it('keeps an unrelated grouping dimension for distinct entities by group', () => {
        const plan = P({ dimensions: [{ field: 'doctor' }, { field: 'department' }], metrics: [{ field: 'doctor', agg: 'count' }], filters: [] });
        applyCountSemantics('count_distinct', plan, model);
        expect(plan.metrics).toEqual([{ field: 'doctor', agg: 'count_distinct' }]);
        expect(plan.dimensions).toEqual([{ field: 'department' }]);
    });

    it('validators ACCEPT the "*" row-count sentinel (no phantom-field error)', () => {
        const plan = P({ metrics: [{ field: '*', agg: 'count' }], filters: [{ field: 'gender', op: '=', value: 'Male' }] });
        const v = validatePlan(plan, model);
        const fieldErrors = v.errors.filter(e => e.rule === 'field_exists' && e.field === '*');
        expect(fieldErrors).toHaveLength(0);
        expect(v.valid).toBe(true);
    });
});

describe('end-to-end: the fixed plan yields the correct COUNT', () => {
    it('COUNT(*) WHERE gender=Male AND age>50 equals the JS count (not a giant sum)', () => {
        const plan = P({ metrics: [{ field: '*', agg: 'count' }], filters: [{ field: 'gender', op: '=', value: 'Male' }, { field: 'age', op: '>', value: 50 }] });
        const sql = gen(plan);
        expect(sql.toUpperCase()).toContain('COUNT(*)');
        expect(sql.toUpperCase()).not.toContain('SUM(');
        const got = num(Object.values(run(plan)[0])[0]);
        const expected = rows.filter(r => r.gender === 'Male' && Number(r.age) > 50).length;
        expect(got).toBe(expected);
        expect(got).toBeLessThan(rows.length);       // proves it filtered
        expect(got).toBeLessThan(1000);              // a count, not a 963,575-style sum
    });
});
