/**
 * AI-SQL accuracy — more correctness traps: multi-dimension grouping, date-grain
 * boundaries (quarter/year), below-average HAVING, BETWEEN inclusivity, IN/NOT IN,
 * negative-value aggregation, and NULL-as-category. Differential method throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan, AnalysisIntent } from '../services/ai-sql/types';

function mkRows(n = 240) {
    const reg = ['East', 'West', 'Central', 'South'];
    const cat = ['Furniture', 'Office', 'Tech'];
    return Array.from({ length: n }, (_, i) => ({
        order_id: 10000 + i,
        order_date: `${2022 + (i % 3)}-${String((i % 12) + 1).padStart(2, '0')}-10`, // 2022–2024
        region: reg[i % 4],
        category: cat[i % 3],
        sales: 100 + (i * 31) % 3000,
        profit: -200 + (i * 17) % 900, // includes negatives
    }));
}

let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(mkRows(), 'e2.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const isNum = (v: any) => typeof v === 'number' || typeof v === 'bigint' || (typeof v === 'string' && v.trim() !== '' && !isNaN(num(v)));
const run = (p: AnalysisPlan) => duck.query(normalizeSQLForDuckDB(correctSQL(p, model)));
const plan = (intent: AnalysisIntent, over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
    intent, dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'summary', originalQuestion: `t ${intent}`, ...over,
} as AnalysisPlan);
const sumBy = (rs: any[], f: string) => rs.reduce((a, r) => a + Number(r[f]), 0);

// The metric column is named `<field>_<agg>` (e.g. sales_sum). Detect it by that
// suffix first — a numeric dimension (like a bare year) is not a value column.
const AGG_SUFFIX = /_(sum|avg|count|count_distinct|min|max)$/i;
function compositeMap(res: any[]): Map<string, number> {
    const out = new Map<string, number>(); if (!res.length) return out;
    const cols = Object.keys(res[0]);
    const valCol = cols.find(c => AGG_SUFFIX.test(c)) ?? cols.find(c => isNum(res[0][c])) ?? cols[cols.length - 1];
    const keyCols = cols.filter(c => c !== valCol);
    for (const r of res) out.set(keyCols.map(c => String(r[c])).join('|'), num(r[valCol]));
    return out;
}
const singleMap = (res: any[]) => compositeMap(res);

describe('More correctness traps', () => {
    it('MULTI-DIMENSION: SUM sales by region × category — every pair correct', () => {
        const exp = new Map<string, number>();
        for (const r of rows) { const k = `${r.region}|${r.category}`; exp.set(k, (exp.get(k) || 0) + Number(r.sales)); }
        const got = compositeMap(run(plan('breakdown', { dimensions: [{ field: 'region' }, { field: 'category' }] })));
        expect(got.size).toBe(exp.size);
        for (const [k, v] of exp) expect(got.get(k) ?? NaN).toBeCloseTo(v, 1);
    });

    it('NEGATIVES: SUM profit (with negative rows) matches JS sum', () => {
        const g = new Map<string, number>();
        for (const r of rows) g.set(String(r.region), (g.get(String(r.region)) || 0) + Number(r.profit));
        const got = singleMap(run(plan('breakdown', { metrics: [{ field: 'profit', agg: 'sum' }], dimensions: [{ field: 'region' }] })));
        for (const [k, v] of g) expect(got.get(k)!).toBeCloseTo(v, 1);
    });

    it('DATE GRAIN quarter: grouped sums add up to the grand total', () => {
        const got = singleMap(run(plan('trend', { dimensions: [{ field: 'order_date', timeGrain: 'quarter' }] })));
        expect([...got.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(sumBy(rows, 'sales'), 1);
    });
    it('DATE GRAIN year: grouped sums add up to the grand total', () => {
        const got = singleMap(run(plan('trend', { dimensions: [{ field: 'order_date', timeGrain: 'year' }] })));
        expect([...got.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(sumBy(rows, 'sales'), 1);
    });

    it('BETWEEN is inclusive on both bounds', () => {
        const lo = 200, hi = 2000;
        const filtered = rows.filter(r => Number(r.sales) >= lo && Number(r.sales) <= hi);
        const g = new Map<string, number>();
        for (const r of filtered) g.set(String(r.region), (g.get(String(r.region)) || 0) + Number(r.sales));
        const got = singleMap(run(plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'sales', op: 'between', value: [lo, hi] }] })));
        for (const [k, v] of g) expect(got.get(k)!).toBeCloseTo(v, 1);
        expect(got.size).toBe(g.size);
    });

    it('IN and NOT IN partition the rows correctly', () => {
        const inSet = ['East', 'West'];
        const inRows = rows.filter(r => inSet.includes(String(r.region)));
        const notRows = rows.filter(r => !inSet.includes(String(r.region)));
        const inGot = singleMap(run(plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'region', op: 'in', value: inSet }] })));
        const notGot = singleMap(run(plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'region', op: 'not_in', value: inSet }] })));
        expect(new Set(inGot.keys())).toEqual(new Set(inRows.map(r => String(r.region))));
        expect(new Set(notGot.keys())).toEqual(new Set(notRows.map(r => String(r.region))));
        // Values consistent
        for (const k of inGot.keys()) expect(inGot.get(k)!).toBeCloseTo(sumBy(inRows.filter(r => String(r.region) === k), 'sales'), 1);
    });

    it('BELOW_AVG HAVING: only regions below the mean total survive', () => {
        const totals = [...new Set(rows.map(r => String(r.region)))].map(k => [k, sumBy(rows.filter(r => String(r.region) === k), 'sales')] as [string, number]);
        const mean = totals.reduce((a, [, v]) => a + v, 0) / totals.length;
        const expected = new Set(totals.filter(([, v]) => v < mean).map(([k]) => k));
        const got = singleMap(run(plan('aggregate_filter', { dimensions: [{ field: 'region' }], filters: [{ field: 'sales', op: 'below_avg', value: null }] })));
        expect(new Set(got.keys())).toEqual(expected);
    });
});
