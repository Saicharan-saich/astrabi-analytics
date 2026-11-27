/**
 * Next questions from the answer's shape: each one runs, filters the way a
 * click on the chart would, and the totals line up with the answer it came from.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { nextQuestions, unusualPeriod } from '../utils/nextQuestions';
import { AnalysisType, TimeGrain } from '../types';

function rows() {
    const out: Record<string, any>[] = [];
    let id = 1;
    const regions = ['North', 'South', 'East', 'West'];
    const channels = ['Web', 'Store', 'Phone'];
    for (let y = 2025; y <= 2026; y++) for (let m = 0; m < 12; m++) {
        for (let i = 0; i < 60; i++) {
            const region = regions[i % 4];
            let amount = 100 + ((i * 37) % 50) + (region === 'North' ? 300 : 0);
            if (y === 2026 && m === 6 && region === 'South') amount += 900; // a July spike
            out.push({ 'Order ID': `O${id++}`, 'Order Date': `${y}-${String(m + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, Region: region, Channel: channels[Math.floor(i / 4) % 3], Amount: amount });
        }
    }
    return out;
}
const etl = runETLPipeline(rows(), 'Orders.csv');
const ds: any = { id: 'o', name: 'Orders.csv', rows: etl.rows, columns: etl.columns, timeContext: etl.timeContext };
const col = (re: RegExp) => etl.columns.find((c: any) => re.test(c.name))!.name;
const amount = col(/amount/); const region = col(/region/);
const run = (config: any) => runAnalysis(ds, { questionId: 'custom_builder', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: 'all_time', filters: {}, asOfDate: '2026-12-31', ...config } as any);
const total = (r: any) => r.data.reduce((s: number, row: any) => s + Number(row[r.yKey]), 0);

describe('next questions', () => {
    it('over time: asks what happened in the unusual month, and that answer adds up to it', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: 'month', sort: 'oldest' };
        const result = await run(config);
        const next = nextQuestions(ds, config, result);
        const odd = next.find(q => q.label === 'What happened in Jul 2026?');
        expect(odd).toBeTruthy();
        const july = result.data.find((r: any) => r[result.xKey] === '2026-07')!;
        const drilled = await run(odd!.config);
        expect(total(drilled)).toBeCloseTo(Number(july[result.yKey]), 4);
        expect(next.map(q => q.label)).toContain('Against the year before');
        expect(next.length).toBeLessThanOrEqual(4);
    });
    it('by a category: the leader broken down and over time, and the bottom when the list is long', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: region, sort: 'desc' };
        const result = await run(config);
        const labels = nextQuestions(ds, config, result).map(q => q.label);
        expect(labels.some(l => /^North by /.test(l))).toBe(true);
        expect(labels).toContain('North over time');
        const leaderOverTime = nextQuestions(ds, config, result).find(q => q.label === 'North over time')!;
        const drilled = await run(leaderOverTime.config);
        const north = result.data.find((r: any) => r[result.xKey] === 'North')!;
        expect(total(drilled)).toBeCloseTo(Number(north[result.yKey]), 4);
    });
    it('a dominant group can be left out', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: region, sort: 'desc', filters: { [region]: ['North', 'South', 'East'] } };
        const result = await run(config);
        const without = nextQuestions(ds, config, result, 6).find(q => q.label === 'Without North');
        expect(without).toBeTruthy();
        expect(without!.config.filters[region]).not.toContain('North');
    });
    it('a single total gets split', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: '' };
        const result: any = { data: [{ metric: 'Total', value: 1 }], xKey: 'metric', yKey: 'value', config };
        const next = nextQuestions(ds, config, result);
        expect(next.map(q => q.label)).toContain(`by ${region}`);
        expect(next.length).toBeGreaterThan(0);
        for (const q of next) expect((await run(q.config)).data.length).toBeGreaterThan(0);
    });
    it('only calls a period unusual when it really is', () => {
        const flat = Array.from({ length: 12 }, (_, i) => ({ key: `2026-${String(i + 1).padStart(2, '0')}`, value: 100 + (i % 3) }));
        expect(unusualPeriod(flat)).toBeNull();
        expect(unusualPeriod([...flat.slice(0, 11), { key: '2026-12', value: 400 }])).toMatchObject({ key: '2026-12', high: true });
    });
});
