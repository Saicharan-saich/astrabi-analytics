/**
 * The answer-shape matrix: every shape of query result an AI SQL answer can
 * have goes through the real answer builder and the real presentation, then
 * through the answer guard. A shape passes only if nothing had to be
 * repaired — the chart, legend, axis and words already agree with the numbers.
 * Every chart type a person can switch to is checked for pies of non-parts.
 *
 * When a bug is reported, its shape is added here so it can't come back.
 */
import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { buildLeanAnswer } from '../services/ai-sql/leanPipeline';
import { resolveAISQLSemanticModel } from '../services/ai-sql/semanticLayer';
import { presentLeanAnswer } from '../utils/aiSqlAnswerPresentation';
import { arcLegendMode, guardAnswer } from '../utils/answerGuard';

const sales = {
    id: 'sales', name: 'orders.csv', totalRows: 3, etlLogs: [], version: 1,
    rows: [
        { order_id: 'A1', order_date: '2025-01-03', region: 'North', channel: 'Online', revenue: 120, cost: 70, returned: 'No' },
        { order_id: 'A2', order_date: '2025-02-05', region: 'South', channel: 'In-Store', revenue: 80, cost: 50, returned: 'Yes' },
        { order_id: 'A3', order_date: '2025-04-09', region: 'East', channel: 'Online', revenue: 60, cost: 30, returned: 'No' },
    ],
    columns: [
        { name: 'order_id', type: ColumnType.ID }, { name: 'order_date', type: ColumnType.DATE }, { name: 'region', type: ColumnType.DIMENSION },
        { name: 'channel', type: ColumnType.DIMENSION }, { name: 'revenue', type: ColumnType.METRIC, currency: 'GBP' }, { name: 'cost', type: ColumnType.METRIC, currency: 'GBP' },
        { name: 'returned', type: ColumnType.BOOLEAN },
    ],
} as unknown as Dataset;
const model = resolveAISQLSemanticModel(sales).model;

interface Shape {
    name: string;
    question: string;
    sql: string;
    rows: Record<string, any>[];
    dimensions?: string[];
    measures?: string[];
    /** Percentages in the summary must be values from the rows (no derived shares). */
    summaryPercentsFromRows?: boolean;
    expectNoData?: boolean;
}

const regions = ['North', 'South', 'East', 'West', 'Central', 'Wales'];
const many = Array.from({ length: 60 }, (_, i) => ({ product: `Product ${i + 1}`, total_revenue: 1000 - i * 7 }));
const SHAPES: Shape[] = [
    { name: 'one total (money)', question: 'What was total revenue?', sql: 'SELECT SUM("revenue") AS total_revenue FROM "data"', rows: [{ total_revenue: 248377 }], measures: ['total_revenue'] },
    { name: 'one count', question: 'How many orders?', sql: 'SELECT COUNT(DISTINCT "order_id") AS order_count FROM "data"', rows: [{ order_count: 1427 }], measures: ['order_count'] },
    { name: 'one rate', question: 'What % of orders were returned?', sql: 'SELECT ROUND(100.0 * COUNT_IF("returned" = \'Yes\') / COUNT(*), 1) AS return_rate_pct FROM "data"', rows: [{ return_rate_pct: 6.9 }], measures: ['return_rate_pct'], summaryPercentsFromRows: true },
    { name: 'one rate with its count', question: 'What is the no-show rate?', sql: 'SELECT ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 1) AS no_show_rate_pct, COUNT(*) AS appointments FROM "data"', rows: [{ no_show_rate_pct: 20.2, appointments: 106987 }], measures: ['no_show_rate_pct', 'appointments'], summaryPercentsFromRows: true },
    { name: 'several rates with a count (reported 8 Nov)', question: 'What percentage of appointments involve hypertension, diabetes, alcoholism or a disability?', sql: 'SELECT ROUND(100.0 * COUNT_IF("hipertension") / NULLIF(COUNT(*), 0), 1) AS hypertension_rate_pct, ROUND(100.0 * COUNT_IF("diabetes") / NULLIF(COUNT(*), 0), 1) AS diabetes_rate_pct, ROUND(100.0 * COUNT_IF("alcoholism") / NULLIF(COUNT(*), 0), 1) AS alcoholism_rate_pct, ROUND(100.0 * COUNT_IF("handcap") / NULLIF(COUNT(*), 0), 1) AS disability_rate_pct, COUNT(*) AS appointment_count FROM "data"', rows: [{ hypertension_rate_pct: 20.4, diabetes_rate_pct: 7.4, alcoholism_rate_pct: 3.1, disability_rate_pct: 2.1, appointment_count: 106987 }], summaryPercentsFromRows: true },
    { name: 'several amounts', question: 'Show revenue, cost and profit', sql: 'SELECT SUM("revenue") AS total_revenue, SUM("cost") AS total_cost, SUM("revenue") - SUM("cost") AS profit FROM "data"', rows: [{ total_revenue: 248377, total_cost: 150000, profit: 98377 }] },
    { name: 'an average with its count', question: 'Average order value', sql: 'SELECT ROUND(AVG("revenue"), 2) AS average_revenue, COUNT(*) AS order_count FROM "data"', rows: [{ average_revenue: 174.06, order_count: 1427 }] },
    { name: 'two groups (money)', question: 'Revenue online vs in store', sql: 'SELECT "channel", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1', rows: [{ channel: 'Online', total_revenue: 100533 }, { channel: 'In-Store', total_revenue: 147844 }], dimensions: ['channel'], measures: ['total_revenue'] },
    { name: 'two groups (rate with count)', question: 'No-show rate with and without SMS', sql: 'SELECT "sms_received", COUNT(*) AS appointments, ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 1) AS no_show_rate_pct FROM "data" GROUP BY 1', rows: [{ sms_received: true, appointments: 1206, no_show_rate_pct: 25 }, { sms_received: false, appointments: 2794, no_show_rate_pct: 12.7 }], dimensions: ['sms_received'], measures: ['no_show_rate_pct', 'appointments'], summaryPercentsFromRows: true },
    { name: 'ranking (money)', question: 'Top 10 products by revenue', sql: 'SELECT "product", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1 ORDER BY 2 DESC LIMIT 10', rows: many.slice(0, 10), dimensions: ['product'], measures: ['total_revenue'] },
    { name: 'ranking (rate with count)', question: 'Which region has the highest return rate?', sql: 'SELECT "region", COUNT(*) AS order_lines, ROUND(100.0 * COUNT_IF("returned" = \'Yes\') / COUNT(*), 1) AS return_rate_pct FROM "data" GROUP BY 1 HAVING COUNT(*) >= 30 ORDER BY 3 DESC', rows: regions.slice(0, 4).map((region, i) => ({ region, order_lines: 600 - i * 20, return_rate_pct: 8.2 - i })), dimensions: ['region'], measures: ['return_rate_pct', 'order_lines'], summaryPercentsFromRows: true },
    { name: 'rates by group asked as "percentage of" (not parts of a whole)', question: 'What percentage of orders were returned in each region?', sql: 'SELECT "region", ROUND(100.0 * COUNT_IF("returned" = \'Yes\') / COUNT(*), 1) AS return_rate_pct FROM "data" GROUP BY 1', rows: regions.slice(0, 4).map((region, i) => ({ region, return_rate_pct: 5 + i })), dimensions: ['region'], measures: ['return_rate_pct'], summaryPercentsFromRows: true },
    { name: 'share of total (parts of a whole)', question: 'What share of revenue does each region bring?', sql: 'SELECT "region", ROUND(100.0 * SUM("revenue") / SUM(SUM("revenue")) OVER (), 1) AS revenue_share_pct FROM "data" GROUP BY 1', rows: [{ region: 'North', revenue_share_pct: 40 }, { region: 'South', revenue_share_pct: 35 }, { region: 'East', revenue_share_pct: 25 }], dimensions: ['region'], measures: ['revenue_share_pct'] },
    { name: 'monthly trend with a gap', question: 'Monthly revenue', sql: 'SELECT DATE_TRUNC(\'month\', CAST("order_date" AS DATE)) AS period, SUM("revenue") AS total_revenue FROM "data" GROUP BY 1 ORDER BY 1', rows: [{ period: '2025-01-01', total_revenue: 120 }, { period: '2025-02-01', total_revenue: 80 }, { period: '2025-04-01', total_revenue: 60 }], dimensions: ['period'], measures: ['total_revenue'] },
    { name: 'monthly rate', question: 'Return rate by month', sql: 'SELECT DATE_TRUNC(\'month\', CAST("order_date" AS DATE)) AS period, ROUND(100.0 * COUNT_IF("returned" = \'Yes\') / COUNT(*), 1) AS return_rate_pct FROM "data" GROUP BY 1 ORDER BY 1', rows: [{ period: '2025-01-01', return_rate_pct: 6 }, { period: '2025-02-01', return_rate_pct: 9 }, { period: '2025-03-01', return_rate_pct: 7.5 }], dimensions: ['period'], measures: ['return_rate_pct'] },
    { name: 'two groupings', question: 'Revenue by channel and region', sql: 'SELECT "channel", "region", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1, 2', rows: ['Online', 'In-Store'].flatMap(channel => regions.slice(0, 3).map((region, i) => ({ channel, region, total_revenue: 100 * (i + 1) }))), dimensions: ['channel', 'region'], measures: ['total_revenue'] },
    { name: '60 categories', question: 'Revenue by product', sql: 'SELECT "product", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1', rows: many, dimensions: ['product'], measures: ['total_revenue'] },
    { name: 'blanks in a measure', question: 'Revenue by region', sql: 'SELECT "region", SUM("revenue") AS total_revenue FROM "data" GROUP BY 1', rows: [{ region: 'North', total_revenue: 120 }, { region: 'South', total_revenue: null }, { region: 'East', total_revenue: 60 }], dimensions: ['region'], measures: ['total_revenue'] },
    { name: 'gains and losses', question: 'Profit by region', sql: 'SELECT "region", SUM("revenue") - SUM("cost") AS profit FROM "data" GROUP BY 1', rows: [{ region: 'North', profit: 500 }, { region: 'South', profit: -120 }, { region: 'East', profit: 80 }], dimensions: ['region'], measures: ['profit'] },
    { name: 'very large numbers', question: 'Total sales by store', sql: 'SELECT "store", SUM("weekly_sales") AS total_sales FROM "data" GROUP BY 1', rows: [{ store: 1, total_sales: 286204260.66 }, { store: 2, total_sales: 272038239.54 }], dimensions: ['store'], measures: ['total_sales'] },
    { name: 'a filter that matched nothing (blank total)', question: 'Revenue for the Manchster store', sql: 'SELECT SUM("revenue") AS total_revenue FROM "data" WHERE LOWER("store") = LOWER(\'Manchster\')', rows: [{ total_revenue: null }], measures: ['total_revenue'], expectNoData: true },
    { name: 'no rows', question: 'Orders in 2030', sql: 'SELECT * FROM "data" WHERE "order_date" >= \'2030-01-01\'', rows: [], expectNoData: true },
    { name: 'a list of records', question: 'Show the returned orders', sql: 'SELECT "order_id", "region", "revenue" FROM "data" WHERE "returned" = \'Yes\' LIMIT 200', rows: [{ order_id: 'A2', region: 'South', revenue: 80 }, { order_id: 'A9', region: 'North', revenue: 35 }], measures: ['revenue'] },
];

const CHART_TYPES = ['bar', 'horizontalBar', 'line', 'area', 'pie', 'doughnut', 'polarArea', 'kpiCard', 'table'];

function build(shape: Shape) {
    return buildLeanAnswer({
        question: shape.question, sql: shape.sql, rows: shape.rows,
        reply: { title: shape.question, dimensions: shape.dimensions || [], measures: shape.measures, explanation: 'Worked out from the data.' },
        model, dataset: sales, started: 0, repairAttempts: 0, tokens: 1, aiModel: 'test', cautions: [],
    });
}

describe('answer-shape matrix', () => {
    for (const shape of SHAPES) {
        it(shape.name, () => {
            const result = build(shape);
            if (shape.expectNoData) {
                expect(result.rawData).toHaveLength(0);
                expect(result.explanation).toMatch(/no rows matched/i);
                return;
            }
            // 1. What is drawn already agrees with the numbers: the guard repairs nothing.
            const presented = presentLeanAnswer(result, shape.question);
            expect(presented.problems, JSON.stringify(presented.problems)).toEqual([]);
            // 2. The words carry no internal names, NaN or empty lists.
            const text = guardAnswer(presented, { headline: result.narrative?.headline, summary: result.narrative?.summary, insights: result.narrative?.insights });
            expect(text.problems, JSON.stringify(text.problems)).toEqual([]);
            const words = `${result.narrative?.headline} ${result.narrative?.summary} ${(result.narrative?.insights || []).join(' ')}`;
            expect(words).not.toMatch(/including \.|found \d+\s*\|| \.\s*$|\bundefined\b|\bNaN\b/);
            // 3. Percentages stated in the summary are values from the answer, not shares of their sum.
            if (shape.summaryPercentsFromRows) {
                const values = shape.rows.flatMap(row => Object.values(row)).filter((value): value is number => typeof value === 'number');
                for (const match of (result.narrative?.summary || '').matchAll(/(\d+(?:\.\d+)?)%/g)) {
                    const stated = Number(match[1]);
                    expect(values.some(value => Math.abs(value - stated) <= 0.6), `${stated}% is not a value in the answer: ${result.narrative?.summary}`).toBe(true);
                }
            }
            // 4. Whatever chart type a person switches to, a pie never shows separate rates as shares.
            const values = presented.analysis.data.map(row => Number(row[presented.analysis.yKey])).filter(Number.isFinite);
            for (const vis of CHART_TYPES) {
                const switched = guardAnswer({ analysis: { ...presented.analysis, vis: vis as any }, formatting: presented.formatting });
                const arcProblem = switched.problems.find(problem => problem.rule === 'arc-not-parts');
                if (['pie', 'doughnut', 'polarArea'].includes(vis) && arcProblem) {
                    expect(arcLegendMode(presented.analysis.yKey, values).labels).toBe('own-value');
                }
                expect(switched.problems.filter(problem => problem.rule !== 'arc-not-parts')).toEqual([]);
            }
        });
    }
});
