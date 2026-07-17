/**
 * AI-SQL ACCURACY harness — proves the deterministic plan→SQL→DuckDB path returns
 * the mathematically CORRECT numbers, not merely valid syntax. This is the
 * correctness net (the sibling of sqlGeneration.test.ts, which checks syntax).
 *
 * Method: differential testing. For each analysis, the expected answer is computed
 * INDEPENDENTLY in plain JS from the same rows, then asserted against the app's
 * SQL result executed on a real DuckDB engine. Two independent implementations
 * agreeing is strong evidence the SQL (and the plan that produced it) is right.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan, AnalysisIntent } from '../services/ai-sql/types';

// ── Deterministic dataset with known, computable answers ──────────────
function retailRows(n = 200) {
    const seg = ['Consumer', 'Corporate', 'Home Office'];
    const reg = ['East', 'West', 'Central', 'South'];
    const cat = ['Furniture', 'Office Supplies', 'Technology'];
    return Array.from({ length: n }, (_, i) => ({
        order_id: 10000 + i,
        order_date: `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        segment: seg[i % 3],
        region: reg[i % 4],
        category: cat[i % 3],
        sales: 50 + (i * 37) % 4000,
        quantity: 1 + (i % 9),
        profit: -40 + (i * 13) % 600,
    }));
}

let duck: DuckHandle;
let model: any;
let rows: any[]; // the ETL output — the exact rows loaded into DuckDB

beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(retailRows(), 'retail.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);

afterAll(() => duck?.close());

// ── Run a plan through the real path ──────────────────────────────────
function runPlan(plan: AnalysisPlan): any[] {
    return duck.query(normalizeSQLForDuckDB(correctSQL(plan, model)));
}
// DuckDB serializes SUM/COUNT of integer columns as a HUGEINT *string* (JS can't
// hold int128), so treat numeric-looking strings as numbers too.
const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const isNumericVal = (v: any) => typeof v === 'number' || typeof v === 'bigint'
    || (typeof v === 'string' && v.trim() !== '' && !isNaN(num(v)));
// Extract {dimensionKey → value}: key = a non-numeric column, value = a numeric one.
function pickCols(res: any[]): { keyCol: string; valCol: string } {
    const cols = Object.keys(res[0]);
    const keyCol = cols.find(c => !isNumericVal(res[0][c])) ?? cols[0];
    const valCol = cols.find(c => c !== keyCol && isNumericVal(res[0][c])) ?? cols[cols.length - 1];
    return { keyCol, valCol };
}
function resultMap(res: any[]): Map<string, number> {
    const out = new Map<string, number>();
    if (res.length === 0) return out;
    const { keyCol, valCol } = pickCols(res);
    for (const r of res) out.set(String(r[keyCol]), num(r[valCol]));
    return out;
}
function resultScalar(res: any[]): number {
    if (res.length === 0) return NaN;
    const cols = Object.keys(res[0]);
    const valCol = cols.find(c => isNumericVal(res[0][c])) ?? cols[0];
    return num(res[0][valCol]);
}

// ── Independent JS reference aggregators over the SAME rows ────────────
const groupRows = (dim: string) => {
    const m = new Map<string, any[]>();
    for (const r of rows) { const k = String(r[dim]); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return m;
};
const jSum = (rs: any[], f: string) => rs.reduce((a, r) => a + (Number(r[f]) || 0), 0);
const jAvg = (rs: any[], f: string) => { const v = rs.map(r => Number(r[f])).filter(x => !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; };
const jMax = (rs: any[], f: string) => Math.max(...rs.map(r => Number(r[f]) || 0));
const jMin = (rs: any[], f: string) => Math.min(...rs.map(r => Number(r[f]) || 0));
const jCountDistinct = (rs: any[], f: string) => new Set(rs.map(r => String(r[f]))).size;
const expectMapClose = (actual: Map<string, number>, expected: Map<string, number>) => {
    expect(actual.size).toBe(expected.size);
    for (const [k, v] of expected) expect(actual.get(k) ?? NaN).toBeCloseTo(v, 2);
};

const plan = (intent: AnalysisIntent, over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
    intent, dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'summary', originalQuestion: `test ${intent}`, ...over,
} as AnalysisPlan);

describe('AI-SQL accuracy — SQL result matches an independent JS computation', () => {
    it('single_metric: total sales', () => {
        const got = resultScalar(runPlan(plan('single_metric')));
        expect(got).toBeCloseTo(jSum(rows, 'sales'), 2);
    });

    it('breakdown: SUM sales by region', () => {
        const exp = new Map([...groupRows('region')].map(([k, rs]) => [k, jSum(rs, 'sales')]));
        expectMapClose(resultMap(runPlan(plan('breakdown', { dimensions: [{ field: 'region' }] }))), exp);
    });

    it('breakdown: AVG profit by segment', () => {
        const exp = new Map([...groupRows('segment')].map(([k, rs]) => [k, jAvg(rs, 'profit')]));
        expectMapClose(resultMap(runPlan(plan('breakdown', { metrics: [{ field: 'profit', agg: 'avg' }], dimensions: [{ field: 'segment' }] }))), exp);
    });

    it('breakdown: MAX sales by category', () => {
        const exp = new Map([...groupRows('category')].map(([k, rs]) => [k, jMax(rs, 'sales')]));
        expectMapClose(resultMap(runPlan(plan('breakdown', { metrics: [{ field: 'sales', agg: 'max' }], dimensions: [{ field: 'category' }] }))), exp);
    });

    it('breakdown: MIN profit by region', () => {
        const exp = new Map([...groupRows('region')].map(([k, rs]) => [k, jMin(rs, 'profit')]));
        expectMapClose(resultMap(runPlan(plan('breakdown', { metrics: [{ field: 'profit', agg: 'min' }], dimensions: [{ field: 'region' }] }))), exp);
    });

    it('breakdown: COUNT_DISTINCT orders by region', () => {
        const exp = new Map([...groupRows('region')].map(([k, rs]) => [k, jCountDistinct(rs, 'order_id')]));
        expectMapClose(resultMap(runPlan(plan('breakdown', { metrics: [{ field: 'order_id', agg: 'count_distinct' }], dimensions: [{ field: 'region' }] }))), exp);
    });

    it('filtered breakdown: SUM sales by region WHERE segment = Consumer', () => {
        const filtered = rows.filter(r => r.segment === 'Consumer');
        const g = new Map<string, any[]>();
        for (const r of filtered) { const k = String(r.region); (g.get(k) ?? g.set(k, []).get(k)!).push(r); }
        const exp = new Map([...g].map(([k, rs]) => [k, jSum(rs, 'sales')]));
        expectMapClose(resultMap(runPlan(plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'segment', op: '=', value: 'Consumer' }] }))), exp);
    });

    it('ranking: top 3 segment by SUM sales — correct values AND descending order', () => {
        const all = [...groupRows('segment')].map(([k, rs]) => [k, jSum(rs, 'sales')] as [string, number])
            .sort((a, b) => b[1] - a[1]).slice(0, 3);
        const res = runPlan(plan('ranking', { dimensions: [{ field: 'segment' }], sort: [{ field: 'sales', dir: 'desc' }], limit: 3 }));
        const m = resultMap(res);
        // Values correct
        for (const [k, v] of all) expect(m.get(k) ?? NaN).toBeCloseTo(v, 2);
        // Order is descending by value (read the value column directly, in order)
        const { valCol } = pickCols(res);
        const vals = res.map(r => num(r[valCol]));
        for (let i = 1; i < vals.length; i++) expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
    });

    it('trend: SUM sales by month sums to the grand total (no double counting)', () => {
        const res = runPlan(plan('trend', { dimensions: [{ field: 'order_date', timeGrain: 'month' }] }));
        const total = [...resultMap(res).values()].reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(jSum(rows, 'sales'), 1);
    });

    it('share_of_total: percentages sum to ~100', () => {
        const res = runPlan(plan('share_of_total', { dimensions: [{ field: 'region' }] }));
        // Find the percentage column (values in 0–100 that sum to ~100).
        const cols = Object.keys(res[0] || {});
        for (const c of cols) {
            const vals = res.map(r => num(r[c])).filter(v => !isNaN(v));
            const sum = vals.reduce((a, b) => a + b, 0);
            if (Math.abs(sum - 100) < 0.5) { expect(sum).toBeCloseTo(100, 1); return; }
        }
        throw new Error('no percentage column summed to 100 — share_of_total is wrong');
    });

    // Hand-checked tiny dataset — guards against a systematic bug shared by both
    // the JS reference and the SQL (independent hardcoded truth).
    it('hand-computed: SUM by group on a known 4-row table', () => {
        const tiny = [
            { grp: 'A', amt: 10 }, { grp: 'A', amt: 15 },
            { grp: 'B', amt: 7 }, { grp: 'B', amt: 3 },
        ];
        const etl = runETLPipeline(tiny, 'tiny.csv');
        const m2 = buildSemanticModel({ id: 't2', name: 'data', rows: etl.rows, columns: etl.columns, totalRows: 4, etlLogs: [] } as any);
        duck.loadTable('data', etl.rows);
        const res = duck.query(normalizeSQLForDuckDB(correctSQL(
            plan('breakdown', { metrics: [{ field: 'amt', agg: 'sum' }], dimensions: [{ field: 'grp' }] }), m2,
        )));
        const m = resultMap(res);
        expect(m.get('A')).toBe(25); // 10 + 15
        expect(m.get('B')).toBe(10); // 7 + 3
        // restore the main table for any later tests
        duck.loadTable('data', rows);
    });
});
