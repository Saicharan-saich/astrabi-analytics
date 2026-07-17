/**
 * Vocabulary robustness — the LLM emits plans with varied spellings for
 * aggregations, sort directions, and time grains. The engine must understand
 * them (or normalize them) rather than emit invalid SQL or silently default,
 * which is the same class of bug as the "eq" filter that silently dropped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';

function mk(n = 240) {
    // Multiple distinct DAYS per month so "monthly" (12 buckets) is distinguishable
    // from "daily" (many buckets) — catches a grain silently falling back to raw date.
    return Array.from({ length: n }, (_, i) => ({
        id: i, dept: ['Cardio', 'Onco', 'Neuro'][i % 3],
        order_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 25) + 1).padStart(2, '0')}`,
        amount: 100 + (i * 31) % 3000,
    }));
}
let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(mk(), 'v.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const run = (p: any) => duck.query(normalizeSQLForDuckDB(correctSQL(p, model)));
const P = (o: any): any => ({ intent: 'breakdown', dimensions: [{ field: 'dept' }], metrics: [{ field: 'amount', agg: 'sum' }], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 's', originalQuestion: '', ...o });
const g = (dim: string) => { const m = new Map<string, any[]>(); for (const r of rows) { const k = String(r[dim]); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
const jAvg = (rs: any[], f: string) => rs.reduce((a, r) => a + Number(r[f]), 0) / rs.length;
const valOf = (r: any) => { const c = Object.keys(r).find(k => /_(sum|avg|count|min|max)/.test(k))!; return num(r[c]); };

describe('Vocabulary robustness (aggregations / sort / grain)', () => {
    it('agg "average" behaves as AVG (not AVERAGE(...) error, not SUM)', () => {
        const res = run(P({ metrics: [{ field: 'amount', agg: 'average' }] }));
        for (const r of res) {
            const d = String(Object.values(r)[0]);
            expect(valOf(r)).toBeCloseTo(jAvg(g('dept').get(d)!, 'amount'), 2);
        }
    });
    it('agg "total" behaves as SUM', () => {
        const res = run(P({ metrics: [{ field: 'amount', agg: 'total' }] }));
        for (const r of res) {
            const d = String(Object.values(r)[0]);
            expect(valOf(r)).toBeCloseTo(g('dept').get(d)!.reduce((a, x) => a + Number(x.amount), 0), 1);
        }
    });
    it('agg "distinct"/"unique" behaves as COUNT DISTINCT', () => {
        for (const agg of ['distinct', 'unique', 'distinct_count', 'count_unique']) {
            const res = run(P({ metrics: [{ field: 'dept', agg }] }));
            for (const r of res) {
                const d = String(Object.values(r)[0]);
                expect(valOf(r), `agg ${agg}`).toBe(new Set(g('dept').get(d)!.map(x => x.dept)).size);
            }
        }
    });
    it('sort dir "descending"/"ascending" produce valid ordered SQL', () => {
        const desc = run(P({ intent: 'ranking', sort: [{ field: 'amount', dir: 'descending' }], limit: 3 }));
        const dv = desc.map(valOf);
        for (let i = 1; i < dv.length; i++) expect(dv[i]).toBeLessThanOrEqual(dv[i - 1]);
        const asc = run(P({ intent: 'ranking', sort: [{ field: 'amount', dir: 'ascending' }], limit: 3 }));
        const av = asc.map(valOf);
        for (let i = 1; i < av.length; i++) expect(av[i]).toBeGreaterThanOrEqual(av[i - 1]);
    });
    it('time grain "monthly"/"weekly"/"daily" group correctly (sum to total AND right buckets)', () => {
        const total = rows.reduce((a, r) => a + Number(r.amount), 0);
        for (const grain of ['monthly', 'weekly', 'daily', 'yearly']) {
            const res = run(P({ intent: 'trend', dimensions: [{ field: 'order_date', timeGrain: grain }] }));
            expect(res.map(valOf).reduce((a, b) => a + b, 0), `grain ${grain} total`).toBeCloseTo(total, 1);
        }
        // "monthly" must bucket by MONTH (12 buckets for a full year), not by day.
        const monthly = run(P({ intent: 'trend', dimensions: [{ field: 'order_date', timeGrain: 'monthly' }] }));
        expect(monthly.length).toBe(12);
        // "daily" produces many more buckets than 12.
        const daily = run(P({ intent: 'trend', dimensions: [{ field: 'order_date', timeGrain: 'daily' }] }));
        expect(daily.length).toBeGreaterThan(12);
    });
});
