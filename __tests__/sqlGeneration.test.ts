/**
 * SQL generation integration test — proves the deterministic SQL the app
 * EXECUTES (from the AI-SQL correction engine) is valid DuckDB syntax and runs
 * against a real DuckDB engine, across every analysis intent. Catches the class
 * of "generated SQL is malformed" bug directly instead of by eyeballing strings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan, AnalysisIntent } from '../services/ai-sql/types';
import { buildQueryPlan, compileSQL, compileEnrichedSQL } from '../services/queryPlan';
import { getDates } from '../services/dateHelpers';
import { AggregationType } from '../types';

// ── Sample dataset (retail) ──────────────────────────────────────────
function retailRows(n = 120) {
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
        discount: (i % 50) / 100,
    }));
}

let duck: DuckHandle;
let model: any;
let rows: any[];

beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(retailRows(), 'retail.csv');
    rows = etl.rows;
    const dataset: any = {
        id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length,
        etlLogs: [], timeContext: etl.timeContext,
    };
    model = buildSemanticModel(dataset);
    duck.loadTable('data', rows);
}, 60000);

afterAll(() => duck?.close());

// Minimal valid plan for a given intent.
function plan(intent: AnalysisIntent, over: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent,
        dimensions: [],
        metrics: [{ field: 'sales', agg: 'sum' }],
        filters: [],
        sort: [],
        limit: null,
        ambiguous: false,
        resultGrain: 'summary',
        originalQuestion: `test ${intent}`,
        ...over,
    } as AnalysisPlan;
}

// Every intent → a representative plan the UI can produce.
const cases: { name: string; plan: AnalysisPlan }[] = [
    { name: 'single_metric: total sales', plan: plan('single_metric') },
    { name: 'breakdown: sales by region', plan: plan('breakdown', { dimensions: [{ field: 'region' }] }) },
    { name: 'breakdown: profit by category', plan: plan('breakdown', { metrics: [{ field: 'profit', agg: 'sum' }], dimensions: [{ field: 'category' }] }) },
    { name: 'trend: sales by month', plan: plan('trend', { dimensions: [{ field: 'order_date', timeGrain: 'month' }] }) },
    { name: 'trend: sales by quarter', plan: plan('trend', { dimensions: [{ field: 'order_date', timeGrain: 'quarter' }] }) },
    { name: 'ranking: top 5 segment by sales', plan: plan('ranking', { dimensions: [{ field: 'segment' }], sort: [{ field: 'sales', dir: 'desc' }], limit: 5 }) },
    { name: 'share_of_total: sales by region', plan: plan('share_of_total', { dimensions: [{ field: 'region' }] }) },
    { name: 'correlation: sales vs profit by category', plan: plan('correlation', { metrics: [{ field: 'sales', agg: 'sum' }, { field: 'profit', agg: 'sum' }], dimensions: [{ field: 'category' }] }) },
    { name: 'distribution: order values', plan: plan('distribution', { metrics: [{ field: 'sales', agg: 'sum' }] }) },
    { name: 'aggregate_filter: regions above avg sales', plan: plan('aggregate_filter', { dimensions: [{ field: 'region' }], filters: [{ field: 'sales', op: 'above_avg', value: null }] }) },
    { name: 'avg aggregation: avg discount by segment', plan: plan('breakdown', { metrics: [{ field: 'discount', agg: 'avg' }], dimensions: [{ field: 'segment' }] }) },
    { name: 'count_distinct: distinct orders by region', plan: plan('breakdown', { metrics: [{ field: 'order_id', agg: 'count_distinct' }], dimensions: [{ field: 'region' }] }) },
    { name: 'filtered breakdown: sales by region where segment=Consumer', plan: plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'segment', op: '=', value: 'Consumer' }] }) },
    // ── Filter operators ──
    { name: 'filter IN: sales by category where region in list', plan: plan('breakdown', { dimensions: [{ field: 'category' }], filters: [{ field: 'region', op: 'in', value: ['East', 'West'] }] }) },
    { name: 'filter NOT_IN', plan: plan('breakdown', { dimensions: [{ field: 'category' }], filters: [{ field: 'region', op: 'not_in', value: ['East'] }] }) },
    { name: 'filter BETWEEN on metric', plan: plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'sales', op: 'between', value: [100, 2000] }] }) },
    { name: 'filter LIKE', plan: plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'segment', op: 'like', value: 'Con' }] }) },
    { name: 'filter > and <', plan: plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'sales', op: '>', value: 100 }, { field: 'profit', op: '<', value: 500 }] }) },
    // ── Date filters ──
    { name: 'date filter this_year', plan: plan('breakdown', { dimensions: [{ field: 'region' }], filters: [{ field: 'order_date', op: 'this_year', value: null }] }) },
    // ── Multi-dimension ──
    { name: 'breakdown by region + category', plan: plan('breakdown', { dimensions: [{ field: 'region' }, { field: 'category' }] }) },
    { name: 'trend by month + region', plan: plan('trend', { dimensions: [{ field: 'order_date', timeGrain: 'month' }, { field: 'region' }] }) },
    // ── Comparisons ──
    { name: 'total_comparison: previous period', plan: plan('total_comparison', { comparison: { type: 'previous_period', mode: 'total' } }) },
    { name: 'trend_comparison: prev period trend', plan: plan('trend_comparison', { dimensions: [{ field: 'order_date', timeGrain: 'month' }], comparison: { type: 'previous_period', mode: 'trend', grain: 'month' } }) },
    // ── Growth ──
    { name: 'growth_analysis: revenue growth by category', plan: plan('growth_analysis', { dimensions: [{ field: 'category' }] }) },
    // ── min / max aggregations ──
    { name: 'max sales by region', plan: plan('breakdown', { metrics: [{ field: 'sales', agg: 'max' }], dimensions: [{ field: 'region' }] }) },
    { name: 'min profit by region', plan: plan('breakdown', { metrics: [{ field: 'profit', agg: 'min' }], dimensions: [{ field: 'region' }] }) },
    { name: 'count rows by region', plan: plan('breakdown', { metrics: [{ field: 'sales', agg: 'count' }], dimensions: [{ field: 'region' }] }) },
];

describe('AI-SQL correction engine → executes as valid DuckDB', () => {
    for (const c of cases) {
        it(c.name, () => {
            const raw = correctSQL(c.plan, model);
            const sql = normalizeSQLForDuckDB(raw);
            let out: any[] | undefined;
            expect(() => { out = duck.query(sql); }, `generated SQL failed to execute:\n${sql}`).not.toThrow();
            expect(out).toBeDefined();
        });
    }
});

// ── Question Builder path: buildQueryPlan → compileSQL/compileEnrichedSQL ──
// The builder computes data in JS but shows this compiled SQL as the preview
// (and it can execute via DuckDB). Malformed preview SQL reads as "SQL syntax is
// incorrect" even when the numbers are right — so validate it actually runs.
describe('Question Builder → compiled preview SQL executes as valid DuckDB', () => {
    const dates = getDates('2024-12-31');
    const cfg = (over: any) => ({ metric: 'sales', aggregation: AggregationType.SUM, dimension: 'region', filters: {}, ...over });
    const exec = (sql: string) => {
        const norm = normalizeSQLForDuckDB(sql);
        let out: any[] | undefined;
        expect(() => { out = duck.query(norm); }, `builder SQL failed:\n${norm}`).not.toThrow();
        expect(out).toBeDefined();
    };

    it('base breakdown', () => {
        const plan = buildQueryPlan(cfg({}), 'order_date', dates, 'data');
        exec(compileSQL(plan));
    });
    it('trend by month', () => {
        const plan = buildQueryPlan(cfg({ dimension: 'month' }), 'order_date', dates, 'data');
        exec(compileSQL(plan));
    });
    it('sorted + limited ranking', () => {
        const plan = buildQueryPlan(cfg({ sort: 'desc', limit: 5 }), 'order_date', dates, 'data');
        exec(compileSQL(plan));
    });
    it('measure filter (HAVING)', () => {
        const plan = buildQueryPlan(cfg({ measureFilters: [{ metric: 'sales', operator: '>', value: 100 }] }), 'order_date', dates, 'data');
        exec(compileSQL(plan));
    });

    // Enriched: table calculations (window functions) + comparisons
    for (const calc of ['pct_of_total', 'rank', 'running_total', 'moving_avg', 'pct_change', 'difference'] as const) {
        it(`table calc: ${calc} (trend)`, () => {
            const plan = buildQueryPlan(cfg({ dimension: 'month' }), 'order_date', dates, 'data');
            exec(compileEnrichedSQL({ basePlan: plan, calculations: [calc] } as any));
        });
    }
    it('comparison: previous period on a trend', () => {
        const plan = buildQueryPlan(cfg({ dimension: 'month' }), 'order_date', dates, 'data');
        exec(compileEnrichedSQL({ basePlan: plan, comparison: { type: 'previous_period' } } as any));
    });
});
