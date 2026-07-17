/**
 * Regression for the reported bug: the LLM planned `gender eq "Male"` but the
 * engine only understood "=", so it SILENTLY DROPPED the filter and counted every
 * patient. Filter operators must be normalized so word-form ops the LLM emits
 * ("eq", "gt", "in_list", …) always produce a WHERE clause.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

function patients(n = 400) {
    const g = ['Male', 'Female'];
    return Array.from({ length: n }, (_, i) => ({
        patient_id: 1000 + i, name: `P${i}`, gender: g[i % 2],
        age: 18 + (i % 70), department: ['Cardio', 'Onco', 'Neuro'][i % 3], billing_amount: 500 + (i * 37) % 40000,
    }));
}
let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(patients(), 'p.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [] } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const run = (p: any) => duck.query(normalizeSQLForDuckDB(correctSQL(p as AnalysisPlan, model)));
const gen = (p: any) => normalizeSQLForDuckDB(correctSQL(p as AnalysisPlan, model));
const P = (o: any): any => ({ intent: 'single_metric', dimensions: [], metrics: [{ field: 'name', agg: 'count' }], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'scalar', originalQuestion: '', ...o });

describe('Filter operator normalization', () => {
    it('THE BUG: "How many male patients?" (op "eq") actually filters to Male', () => {
        const p = P({ filters: [{ field: 'gender', op: 'eq', value: 'Male' }] });
        const sql = gen(p);
        expect(sql.toUpperCase()).toContain('WHERE'); // was missing entirely before the fix
        const got = num(Object.values(run(p)[0])[0]);
        const expected = rows.filter(r => r.gender === 'Male').length;
        expect(got).toBe(expected);
        expect(got).toBeLessThan(rows.length); // proves it did NOT count everyone
    });

    it('word-form comparison ops all filter correctly', () => {
        const cases: Array<[string, (r: any) => boolean]> = [
            ['gt', r => Number(r.age) > 50], ['gte', r => Number(r.age) >= 50],
            ['lt', r => Number(r.age) < 50], ['lte', r => Number(r.age) <= 50],
            ['neq', r => r.gender !== 'Male'],
        ];
        for (const [op, pred] of cases) {
            const field = op.startsWith('n') ? 'gender' : 'age';
            const value = op.startsWith('n') ? 'Male' : 50;
            const got = num(Object.values(run(P({ filters: [{ field, op, value }] }))[0])[0]);
            expect(got, `op ${op}`).toBe(rows.filter(pred).length);
        }
    });

    it('word-form set ops (in_list / none_of) filter correctly', () => {
        const inGot = num(Object.values(run(P({ filters: [{ field: 'department', op: 'in_list', value: ['Cardio', 'Neuro'] }] }))[0])[0]);
        expect(inGot).toBe(rows.filter(r => ['Cardio', 'Neuro'].includes(r.department)).length);
        const outGot = num(Object.values(run(P({ filters: [{ field: 'department', op: 'none_of', value: ['Cardio'] }] }))[0])[0]);
        expect(outGot).toBe(rows.filter(r => r.department !== 'Cardio').length);
    });
});
