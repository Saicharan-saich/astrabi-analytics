/**
 * "Why did it change?": the parts add up to the change on screen, a planted
 * driver is found, filters still apply, and averages are not split.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { explainChange, canExplainChange, periodLabel, candidateGroupings } from '../services/explainChange';
import { AnalysisType, TimeGrain } from '../types';

// Two years of orders; in the last month the North stores jump and Web dips.
function rows() {
    const out: Record<string, any>[] = [];
    let id = 1;
    const regions = ['North', 'South', 'East', 'West'];
    const channels = ['Web', 'Store', 'Phone'];
    for (let m = 0; m < 12; m++) {
        for (let i = 0; i < 60; i++) {
            const region = regions[i % 4];
            const channel = channels[Math.floor(i / 4) % 3];
            let amount = 100 + ((i * 37) % 50);
            if (m === 11 && region === 'North') amount += 400;
            if (m === 11 && channel === 'Web') amount -= 40;
            out.push({ 'Order ID': `O${id++}`, 'Order Date': `2026-${String(m + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, Region: region, Channel: channel, Amount: amount });
        }
    }
    return out;
}
const etl = runETLPipeline(rows(), 'Orders.csv');
const ds: any = { id: 'o', name: 'Orders.csv', rows: etl.rows, columns: etl.columns, timeContext: etl.timeContext };
const amount = etl.columns.find((c: any) => /amount/.test(c.name))!.name;
const region = etl.columns.find((c: any) => /region/.test(c.name))!.name;
const channel = etl.columns.find((c: any) => /channel/.test(c.name))!.name;
const query = (config: any) => ({ questionId: 'custom_builder', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: 'all_time', filters: {}, asOfDate: '2026-12-31', ...config });
const run = (config: any) => runAnalysis(ds, query(config) as any);

describe('why did it change', () => {
    it('finds the planted driver and the parts add up to the change', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: 'month', sort: 'oldest' };
        const result = await run(config);
        const why = await explainChange(ds, config, result, run);
        expect(why).not.toBeNull();
        expect(why!.from.key).toBe('2026-11');
        expect(why!.to.key).toBe('2026-12');
        expect(why!.grouping).toBe(region);
        expect(why!.movers[0].key).toBe('North');
        const sum = why!.movers.reduce((s, m) => s + m.delta, 0);
        expect(sum).toBeCloseTo(why!.change, 6);
        expect(why!.sentences[0]).toMatch(/From Nov 2026 to Dec 2026 it went up by/);
        expect(why!.sentences.join(' ')).toMatch(/North moved by more than the whole change \(\+5,800\)/);
    });
    it('keeps the question’s filters', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: 'month', sort: 'oldest', filters: { [channel]: ['Web'] } };
        const result = await run(config);
        const why = await explainChange(ds, config, result, run);
        const north = why!.movers.find(m => m.key === 'North')!;
        // 5 Web orders in the North each month, each +400 −40 in December.
        expect(north.delta).toBeCloseTo(5 * 360, 6);
        expect(candidateGroupings(ds, config)).not.toContain(channel);
    });
    it('explains any period against the one before', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: 'month', sort: 'oldest' };
        const result = await run(config);
        const flat = await explainChange(ds, config, result, run, '2026-06');
        expect(flat).toBeNull(); // nothing changed between May and June
    });
    it('only splits totals and counts over time', async () => {
        const avg = { metric: amount, aggregation: 'AVG', dimension: 'month' };
        expect(canExplainChange(avg, await run(avg))).toBe(false);
        const byRegion = { metric: amount, aggregation: 'SUM', dimension: region };
        expect(canExplainChange(byRegion, await run(byRegion))).toBe(false);
        const count = { metric: amount, aggregation: 'COUNT', dimension: 'quarter' };
        expect(canExplainChange(count, await run(count))).toBe(true);
    });
    it('says periods the way people do', () => {
        expect(periodLabel('2026-03')).toBe('Mar 2026');
        expect(periodLabel('2026-Q1')).toBe('Q1 2026');
        expect(periodLabel('2026-03-05')).toBe('5 Mar 2026');
        expect(periodLabel('2025')).toBe('2025');
    });
});
