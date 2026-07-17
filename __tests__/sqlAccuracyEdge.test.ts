/**
 * AI-SQL accuracy — CORRECTNESS EDGE CASES (the traps that make a number wrong
 * even when the SQL is valid): non-additive aggregation, ordinal ratings,
 * post-aggregate (HAVING) filters, and the time anchor. Same differential method:
 * the app's plan→correctSQL→DuckDB result is checked against an independent JS
 * computation of the correct answer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan, AnalysisIntent } from '../services/ai-sql/types';

function rows_(n = 180) {
    const reg = ['East', 'West', 'Central', 'South'];
    return Array.from({ length: n }, (_, i) => ({
        order_id: 10000 + i,
        order_date: `${2020 + (i % 5)}-${String((i % 12) + 1).padStart(2, '0')}-15`, // spans 2020–2024
        region: reg[i % 4],
        sales: 100 + (i * 31) % 3000,
        discount: (i % 50) / 100,          // 0–0.49 → a RATE (non-additive)
        satisfaction: 1 + (i % 5),          // 1–5 → ordinal rating (non-additive)
    }));
}

let duck: DuckHandle;
let model: any;
let rows: any[];

beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(rows_(), 'edge.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const isNum = (v: any) => typeof v === 'number' || typeof v === 'bigint' || (typeof v === 'string' && v.trim() !== '' && !isNaN(num(v)));
function mapOf(res: any[]): Map<string, number> {
    const out = new Map<string, number>(); if (!res.length) return out;
    const cols = Object.keys(res[0]);
    const keyCol = cols.find(c => !isNum(res[0][c])) ?? cols[0];
    const valCol = cols.find(c => c !== keyCol && isNum(res[0][c])) ?? cols[cols.length - 1];
    for (const r of res) out.set(String(r[keyCol]), num(r[valCol]));
    return out;
}
const run = (p: AnalysisPlan) => duck.query(normalizeSQLForDuckDB(correctSQL(p, model)));
const groupRows = (dim: string) => { const m = new Map<string, any[]>(); for (const r of rows) { const k = String(r[dim]); (m.get(k) ?? m.set(k, []).get(k)!).push(r); } return m; };
const avg = (rs: any[], f: string) => rs.reduce((a, r) => a + Number(r[f]), 0) / rs.length;
const plan = (intent: AnalysisIntent, over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
    intent, dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'summary', originalQuestion: `t ${intent}`, ...over,
} as AnalysisPlan);

describe('Correctness edge cases', () => {
    it('ADDITIVITY: a plan asking SUM(discount) executes as AVG (rate is non-additive)', () => {
        // The plan wrongly says SUM; the guard must produce per-region AVG, not SUM.
        const got = mapOf(run(plan('breakdown', { metrics: [{ field: 'discount', agg: 'sum' }], dimensions: [{ field: 'region' }] })));
        const expAvg = new Map([...groupRows('region')].map(([k, rs]) => [k, avg(rs, 'discount')]));
        // Must match AVG, and must NOT match the (wrong) SUM.
        for (const [k, v] of expAvg) {
            expect(got.get(k)!).toBeCloseTo(v, 3);
            const wrongSum = groupRows('region').get(k)!.reduce((a, r) => a + Number(r.discount), 0);
            expect(Math.abs(got.get(k)! - wrongSum)).toBeGreaterThan(0.01);
        }
    });

    it('ORDINAL: satisfaction rating aggregates as AVG, not SUM', () => {
        const got = mapOf(run(plan('breakdown', { metrics: [{ field: 'satisfaction', agg: 'sum' }], dimensions: [{ field: 'region' }] })));
        const exp = new Map([...groupRows('region')].map(([k, rs]) => [k, avg(rs, 'satisfaction')]));
        for (const [k, v] of exp) expect(got.get(k)!).toBeCloseTo(v, 3); // 1–5 range, not a big sum
    });

    it('ADDITIVE still sums: sales is unaffected by the guard', () => {
        const got = mapOf(run(plan('breakdown', { dimensions: [{ field: 'region' }] })));
        const exp = new Map([...groupRows('region')].map(([k, rs]) => [k, rs.reduce((a, r) => a + Number(r.sales), 0)]));
        for (const [k, v] of exp) expect(got.get(k)!).toBeCloseTo(v, 1);
    });

    it('TEMPORAL: "this_year" filters to the dataset anchor year (not all-time, not NOW())', () => {
        const maxDate = rows.map(r => String(r.order_date)).sort().at(-1)!;
        const anchorYear = maxDate.slice(0, 4);
        const inYear = rows.filter(r => String(r.order_date).startsWith(anchorYear));
        expect(inYear.length).toBeLessThan(rows.length);      // sanity: dataset spans multiple years
        expect(anchorYear).not.toBe(String(new Date().getFullYear())); // anchor is historical, not wall-clock

        const g = new Map<string, any[]>();
        for (const r of inYear) { const k = String(r.region); (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
        const exp = new Map([...g].map(([k, rs]) => [k, rs.reduce((a, r) => a + Number(r.sales), 0)]));
        const got = mapOf(run(plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'order_date', op: 'this_year', value: null }] })));
        expect(got.size).toBe(exp.size);
        for (const [k, v] of exp) expect(got.get(k)!).toBeCloseTo(v, 1);
    });

    it('HAVING: regions with total sales above the average survive the post-aggregate filter', () => {
        const totals = [...groupRows('region')].map(([k, rs]) => [k, rs.reduce((a, r) => a + Number(r.sales), 0)] as [string, number]);
        const mean = totals.reduce((a, [, v]) => a + v, 0) / totals.length;
        const expected = new Set(totals.filter(([, v]) => v > mean).map(([k]) => k));
        const got = mapOf(run(plan('aggregate_filter', { dimensions: [{ field: 'region' }], filters: [{ field: 'sales', op: 'above_avg', value: null }] })));
        expect(new Set(got.keys())).toEqual(expected);
    });
});
