/**
 * AI-SQL accuracy — period COMPARISON (this vs previous period). Verifies the
 * "Current" and "Previous" totals against an independent JS computation, and that
 * the previous period has the SAME LENGTH as the current one (the classic bug:
 * comparing a quarter against just one month).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuck, DuckHandle } from './helpers/duckdbNode';
import { runETLPipeline } from '../services/etlPipeline';
import { buildSemanticModel } from '../services/ai-sql/semanticLayer';
import { correctSQL } from '../services/ai-sql/sqlCorrectionEngine';
import { normalizeSQLForDuckDB } from '../services/duckdbEngine';
import type { AnalysisPlan } from '../services/ai-sql/types';

// One row per month across 2023–2024, each month's sales = a known amount.
function monthlyRows() {
    const out: any[] = [];
    let id = 1;
    for (const y of [2023, 2024]) {
        for (let m = 1; m <= 12; m++) {
            // 3 rows per month so sums are non-trivial
            for (let k = 0; k < 3; k++) {
                out.push({ order_id: id++, order_date: `${y}-${String(m).padStart(2, '0')}-1${k}`, region: ['East', 'West'][k % 2], sales: y * 100 + m * 10 + k });
            }
        }
    }
    return out;
}

let duck: DuckHandle, model: any, rows: any[];
beforeAll(async () => {
    duck = await createDuck();
    const etl = runETLPipeline(monthlyRows(), 'cmp.csv');
    rows = etl.rows;
    model = buildSemanticModel({ id: 't', name: 'data', rows, columns: etl.columns, totalRows: rows.length, etlLogs: [], timeContext: etl.timeContext } as any);
    duck.loadTable('data', rows);
}, 60000);
afterAll(() => duck?.close());

const num = (v: any) => (typeof v === 'bigint' ? Number(v) : Number(String(v).replace(/"/g, '')));
const run = (p: AnalysisPlan) => duck.query(normalizeSQLForDuckDB(correctSQL(p, model)));
const sumInRange = (start: string, end: string) => rows.filter(r => String(r.order_date) >= start && String(r.order_date) <= end).reduce((a, r) => a + Number(r.sales), 0);
// Pull the {period → value} from a comparison result.
function byPeriod(res: any[]): Record<string, number> {
    const out: Record<string, number> = {};
    const valCol = Object.keys(res[0]).find(c => /_(sum|avg|min|max|count)/.test(c))!;
    for (const r of res) out[String(r.period)] = num(r[valCol]);
    return out;
}
const plan = (over: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'total_comparison', dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'summary', originalQuestion: 'vs prev',
    comparison: { type: 'previous_period', mode: 'total' }, ...over,
} as AnalysisPlan);

describe('Period comparison SQL', () => {
    it('casts the date column so a VARCHAR order_date does not crash BETWEEN', () => {
        // Regression: "col BETWEEN DATE '…'" threw "Cannot mix VARCHAR and DATE"
        // when order_date was loaded as text. The column must be cast to DATE.
        const sql = correctSQL(plan({ filters: [{ field: 'order_date', op: 'between', value: ['2024-05-01', '2024-05-31'] }] }), model);
        expect(sql).toMatch(/CAST\(\s*"?order_date"?\s+AS DATE\)\s+BETWEEN/i);
        expect(sql).not.toMatch(/"order_date"\s+BETWEEN\s+DATE/i);
        expect(sql).toMatch(/^WITH periods/i);
        expect(sql).toMatch(/\bLAG\s*\(/i);
        expect(sql).toMatch(/\bgrowth_pct\b/i);
    });
});

describe('Period comparison accuracy', () => {
    it('single month vs previous month', () => {
        const rows = run(plan({ filters: [{ field: 'order_date', op: 'between', value: ['2024-05-01', '2024-05-31'] }] }));
        const res = byPeriod(rows);
        expect(res.Current).toBeCloseTo(sumInRange('2024-05-01', '2024-05-31'), 1);
        expect(res.Previous).toBeCloseTo(sumInRange('2024-04-01', '2024-04-30'), 1);
        const current = rows.find(row => row.period === 'Current');
        const expectedGrowth = (res.Current - res.Previous) * 100 / Math.abs(res.Previous);
        expect(num(current?.growth_pct)).toBeCloseTo(expectedGrowth, 1);
    });

    it('QUARTER vs previous quarter — previous period is a FULL quarter, not one month', () => {
        // Q1 2024 (3 months) → previous should be Q4 2023 (3 months), not Dec 2023.
        const res = byPeriod(run(plan({ filters: [{ field: 'order_date', op: 'between', value: ['2024-01-01', '2024-03-31'] }] })));
        expect(res.Current).toBeCloseTo(sumInRange('2024-01-01', '2024-03-31'), 1);
        expect(res.Previous).toBeCloseTo(sumInRange('2023-10-01', '2023-12-31'), 1);
    });

    it('half-year vs previous half-year', () => {
        // H1 2024 (6 months) → previous should be H2 2023 (6 months).
        const res = byPeriod(run(plan({ filters: [{ field: 'order_date', op: 'between', value: ['2024-01-01', '2024-06-30'] }] })));
        expect(res.Current).toBeCloseTo(sumInRange('2024-01-01', '2024-06-30'), 1);
        expect(res.Previous).toBeCloseTo(sumInRange('2023-07-01', '2023-12-31'), 1);
    });

    it('same_period_last_year', () => {
        const res = byPeriod(run(plan({
            comparison: { type: 'same_period_last_year', mode: 'total' },
            filters: [{ field: 'order_date', op: 'between', value: ['2024-03-01', '2024-03-31'] }],
        })));
        expect(res.Current).toBeCloseTo(sumInRange('2024-03-01', '2024-03-31'), 1);
        expect(res.Previous).toBeCloseTo(sumInRange('2023-03-01', '2023-03-31'), 1);
    });
});
