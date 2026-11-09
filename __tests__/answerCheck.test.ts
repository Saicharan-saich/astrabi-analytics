/**
 * The answer check works every figure out a second time from the cleaned data
 * with its own SQL reader and calculator (no DuckDB). These tests hold it to:
 *   - no false alarms: all 103 business benchmark answers verify;
 *   - catching wrong figures: a 3% error planted in any answer is caught;
 *   - the DuckDB the AI writes: DATE_TRUNC, COUNT_IF, window shares, QUALIFY,
 *     CTEs, relative dates, FILTER, strftime, EXTRACT;
 *   - honest limits: ties and unreadable queries are never called wrong;
 *   - the Question Builder: its answers verify, and the three bugs the check
 *     found there stay fixed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { checkAnswer, sameFigure } from '../services/answerCheck/answerCheck';
import { parseSQL } from '../services/answerCheck/sqlParser';
import { evaluate, SqlDate } from '../services/answerCheck/sqlEval';
import { BUSINESS_BENCHMARK_SUITE } from '../services/benchmark/businessFixtures.generated';
import { runAnalysis, resolveMapping } from '../services/analysisEngine';
import { isoWeekLabel } from '../services/dateHelpers';
import { AggregationType, AnalysisType, ColumnType, TimeGrain, type Dataset, type QueryConfig } from '../types';

const cache = new Map<string, any>();
const load = (ref: string) => {
    if (!cache.has(ref)) cache.set(ref, JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'public', ref))).toString()));
    return cache.get(ref);
};
const dataset = (file: string) => load(`/benchmarks/business-v1/datasets/${file}`);
const RETAIL = 'retail-d14026d08cc0.json.gz';
const WEEKLY = 'weekly-0059558efb15.json.gz';
const APPTS = 'appointments-ac8240e379cb.json.gz';

const run = (sql: string, rows: any[]) => evaluate(parseSQL(sql), { data: rows }).rows
    .map(r => r.map(v => (v instanceof SqlDate ? v.toString() : typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

describe('answer check on the business benchmark', () => {
    it('verifies every gold answer (no false alarms)', () => {
        const notVerified = BUSINESS_BENCHMARK_SUITE.cases
            .map(c => ({ id: c.id, r: checkAnswer({ sql: c.goldSql, rows: c.expectedRows as any, data: load(c.datasetRef).rows }) }))
            .filter(x => x.r.status !== 'verified')
            .map(x => `${x.id}: ${x.r.headline}`);
        expect(notVerified).toEqual([]);
    }, 60000);

    it('catches a 3% error planted in any figure', () => {
        const missed: string[] = [];
        for (const c of BUSINESS_BENCHMARK_SUITE.cases) {
            const rows = JSON.parse(JSON.stringify(c.expectedRows));
            const key = Object.keys(rows[0]).find(k => typeof rows[0][k] === 'number');
            if (!key) continue;
            rows[0][key] = rows[0][key] === 0 ? 1 : rows[0][key] * 1.03;
            const r = checkAnswer({ sql: c.goldSql, rows, data: load(c.datasetRef).rows });
            if (r.status !== 'mismatch') missed.push(c.id);
            else expect(r.differences.length).toBeGreaterThan(0);
        }
        expect(missed).toEqual([]);
    }, 60000);

    it('says what was counted, on how many rows, in plain words', () => {
        const c = BUSINESS_BENCHMARK_SUITE.cases.find(x => x.id === 'business-m12')!;
        const r = checkAnswer({ sql: c.goldSql, rows: c.expectedRows as any, data: load(c.datasetRef).rows, recordWord: 'appointment' });
        expect(r.counted).toBe('Worked out the number of appointments, for each neighbourhood, counting only appointments where showed up is no, keeping the first 3.');
        expect(r.coverage).toBe('Based on 658 of 4,000 appointments (the rest don\'t meet the question\'s conditions).');
        expect(r.notes.join(' ')).toMatch(/The 3 rows shown make up 43\.8% of all missed \(658\)/);
    });
});

describe('the DuckDB the AI writes', () => {
    const retail = dataset(RETAIL).rows, weekly = dataset(WEEKLY).rows, appts = dataset(APPTS).rows;
    const pairs: [string, string, string, any[]][] = [
        ['DATE_TRUNC month', `SELECT strftime(DATE_TRUNC('month', CAST("order_date" AS DATE)), '%Y-%m') AS m, ROUND(SUM("revenue"), 2) AS r FROM "data" WHERE CAST("order_date" AS DATE) >= DATE '2025-01-01' GROUP BY m ORDER BY m`, `SELECT SUBSTR(order_date, 1, 7) AS m, ROUND(SUM(revenue), 2) AS r FROM data WHERE order_date >= '2025-01-01' GROUP BY 1 ORDER BY 1`, retail],
        ['COUNT_IF rate', `SELECT "gender", ROUND(100.0 * COUNT_IF(NOT "showed_up") / COUNT(*), 2) AS no_show_rate_pct FROM "data" GROUP BY ALL ORDER BY 1`, `SELECT gender, ROUND(100.0 * SUM(CASE WHEN showed_up THEN 0 ELSE 1 END) / COUNT(*), 2) FROM data GROUP BY gender ORDER BY 1`, appts],
        ['share with a window', `SELECT "category", ROUND(100.0 * SUM("revenue") / SUM(SUM("revenue")) OVER (), 2) AS share_pct FROM "data" GROUP BY 1 ORDER BY 1`, `SELECT category, ROUND(100.0 * SUM(revenue) / (SELECT SUM(revenue) FROM data), 2) FROM data GROUP BY category ORDER BY 1`, retail],
        ['CTE', `WITH m AS (SELECT "customer_id", COUNT(DISTINCT "order_id") AS n FROM "data" GROUP BY 1) SELECT COUNT(*) AS c FROM m WHERE n > 5`, `SELECT COUNT(*) FROM (SELECT customer_id FROM data GROUP BY customer_id HAVING COUNT(DISTINCT order_id) > 5) t`, retail],
        ['FILTER', `SELECT ROUND(100.0 * SUM("revenue") FILTER (WHERE "channel" = 'Online') / NULLIF(SUM("revenue"), 0), 2) AS p FROM "data"`, `SELECT ROUND(100.0 * SUM(CASE WHEN channel = 'Online' THEN revenue ELSE 0 END) / SUM(revenue), 2) FROM data`, retail],
        ['EXTRACT', `SELECT EXTRACT(year FROM CAST("date" AS DATE)) AS y, ROUND(AVG("fuel_price"), 2) AS f FROM "data" GROUP BY ALL ORDER BY y`, `SELECT CAST(SUBSTR(date, 1, 4) AS INTEGER) AS y, ROUND(AVG(fuel_price), 2) FROM data GROUP BY 1 ORDER BY 1`, weekly],
        ['relative dates', `SELECT ROUND(SUM("revenue"), 2) AS r FROM "data" WHERE CAST("order_date" AS DATE) > (SELECT MAX(CAST("order_date" AS DATE)) FROM "data") - INTERVAL 30 DAY`, `SELECT ROUND(SUM(revenue), 2) FROM data WHERE order_date > (SELECT strftime(CAST(MAX(order_date) AS DATE) - 30, '%Y-%m-%d') FROM data)`, retail],
        ['QUALIFY', `SELECT DATE_TRUNC('month', CAST("order_date" AS DATE)) AS p, "category", SUM("revenue") AS s FROM "data" GROUP BY ALL QUALIFY ROW_NUMBER() OVER (PARTITION BY p ORDER BY s DESC) = 1 ORDER BY p`, `SELECT p, category, s FROM (SELECT DATE_TRUNC('month', CAST(order_date AS DATE)) AS p, category, SUM(revenue) AS s, RANK() OVER (PARTITION BY DATE_TRUNC('month', CAST(order_date AS DATE)) ORDER BY SUM(revenue) DESC) AS rk FROM data GROUP BY 1, 2) t WHERE rk = 1 ORDER BY p`, retail],
        ['LOWER match', `SELECT COUNT(DISTINCT "customer_id") AS c FROM "data" WHERE LOWER("channel") = LOWER('online')`, `SELECT COUNT(DISTINCT customer_id) FROM data WHERE channel = 'Online'`, retail],
    ];
    it.each(pairs)('%s gives the same answer as plain SQL', (_name, ai, plain, rows) => {
        expect(run(ai, rows)).toEqual(run(plain, rows));
    });
});

describe('honest limits', () => {
    const retail = dataset(RETAIL).rows;

    it('a misspelt filter value is flagged with the nearest real values', () => {
        const sql = `SELECT COUNT(*) AS orders FROM "data" WHERE "region" IN ('North', 'Nrth')`;
        const rows = run(sql, retail).map(r => ({ orders: r[0] }));
        const r = checkAnswer({ sql, rows, data: retail });
        expect(r.status).toBe('warning');
        const nrth = r.filterValues.find(f => f.value === 'Nrth')!;
        expect(nrth.matches).toBe(0);
        expect(nrth.suggestions).toContain('North');
        expect(r.headline).toMatch(/did you mean "North"/);
    });

    it('rows tied at the LIMIT are accepted either way', () => {
        const sql = `SELECT "region", COUNT(*) AS n FROM "data" GROUP BY 1 ORDER BY CASE WHEN "region" = 'North' THEN 0 ELSE 1 END LIMIT 2`;
        const all = run(`SELECT "region", COUNT(*) AS n FROM "data" GROUP BY 1`, retail);
        const north = all.find(r => r[0] === 'North')!;
        const other = all.filter(r => r[0] !== 'North').pop()!;
        const r = checkAnswer({ sql, rows: [north, other].map(x => ({ region: x[0], n: x[1] })), data: retail });
        expect(r.status).toBe('verified');
    });

    it('a query it cannot read is "partly checked", never called wrong', () => {
        const sql = `SELECT d."region", SUM(d."revenue") AS r FROM "data" d JOIN "data" e ON d."order_id" = e."order_id" GROUP BY 1`;
        const r = checkAnswer({ sql, rows: [{ region: 'North', r: 1 }], data: retail });
        expect(r.status).toBe('partial');
        expect(r.reason).toBe('join');
    });

    it('a 0 drawn for a group with nothing to add up is a note, not a failure', () => {
        const rows = [{ g: 'a', v: 1 }, { g: 'b', v: null }];
        const r = checkAnswer({ sql: `SELECT "g", SUM("v") AS total FROM "data" GROUP BY 1`, rows: [{ g: 'a', total: 1 }, { g: 'b', total: 0 }], data: rows });
        expect(r.status).toBe('verified');
        expect(r.notes.join(' ')).toMatch(/shown as 0 where there is nothing to add up/);
    });

    it('figures rounded to cents may differ by one cent; whole numbers may not differ at all', () => {
        expect(sameFigure(20.33, 20.32)).toBe(true);
        expect(sameFigure(5, 4)).toBe(false);
        expect(sameFigure('Unknown', null)).toBe(true);
    });
});

describe('Question Builder answers', () => {
    const builderDataset = (file: string, metrics: string[], dates: string[], anchorCol: string, anchor: string): Dataset => {
        const raw = dataset(file);
        const columns = Object.keys(raw.rows[0]).map(k => ({ name: k, type: metrics.includes(k) ? ColumnType.METRIC : dates.includes(k) ? ColumnType.DATE : ColumnType.DIMENSION, originalType: typeof raw.rows[0][k] }));
        return { id: file, name: raw.name, rows: raw.rows, columns, totalRows: raw.rows.length, etlLogs: [], timeContext: { minDate: '2000-01-01', maxDate: anchor, anchorDateColumn: anchorCol, defaultAnchorDate: anchor } } as any;
    };
    const ask = (ds: Dataset, change: Partial<QueryConfig>) => runAnalysis(ds, {
        questionId: 'custom_builder', metric: '', dimension: '', aggregation: AggregationType.SUM, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, asOfDate: ds.timeContext?.maxDate, ...change,
    } as QueryConfig);

    it('verifies totals, averages and counts by category and by period', async () => {
        const ds = builderDataset(RETAIL, ['revenue', 'quantity', 'cost'], ['order_date'], 'order_date', '2025-06-30');
        const failures: string[] = [];
        let verified = 0;
        for (const aggregation of [AggregationType.SUM, AggregationType.AVG, AggregationType.COUNT, AggregationType.MAX, AggregationType.COUNT_DISTINCT]) {
            for (const dimension of ['region', 'category', 'month', 'quarter', 'week', 'year']) {
                const res = await ask(ds, { metric: 'revenue', aggregation, dimension, ...(dimension === 'region' ? { filters: { category: ['Grocery'] } } : {}) });
                if (res.error || !res.data.length) continue; // the Builder declined; nothing to check
                const r = checkAnswer({ sql: res.sql, rows: res.data, data: ds.rows, matchByName: true });
                if (r.status === 'verified') verified++;
                else failures.push(`${aggregation} by ${dimension}: ${r.headline}`);
            }
        }
        expect(failures).toEqual([]);
        expect(verified).toBeGreaterThanOrEqual(25);
    }, 60000);

    it('labels weeks with the ISO week\'s own year (30 Dec 2024 is 2025-W01)', () => {
        expect(isoWeekLabel(new Date(2024, 11, 30, 12))).toBe('2025-W01');
        expect(isoWeekLabel(new Date(2027, 0, 1, 12))).toBe('2026-W53');
        expect(isoWeekLabel(new Date(2025, 5, 18, 12))).toBe('2025-W25');
    });

    it('keeps 0 as a group of its own, not "Unknown"', async () => {
        const ds = builderDataset(WEEKLY, ['weekly_sales', 'temperature', 'fuel_price'], ['date'], 'date', '2012-10-26');
        const res = await ask(ds, { metric: 'weekly_sales', dimension: 'holiday_flag' });
        expect(res.data.map((row: any) => String(row.holiday_flag)).sort()).toEqual(['0', '1']);
        expect(checkAnswer({ sql: res.sql, rows: res.data, data: ds.rows, matchByName: true }).status).toBe('verified');
    });

    it('takes the date from a date column, not a number called "date_diff"', () => {
        const ds = builderDataset(APPTS, ['age', 'date_diff'], ['scheduled_day', 'appointment_day'], 'appointment_day', '2016-06-08');
        expect(resolveMapping(ds).fields.order_date).toBe('appointment_day');
    });
});
