/**
 * Warnings before an answer misleads: each fires when it should, stays quiet
 * when it shouldn't, and its fix runs and gives the honest answer.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { answerWarnings } from '../utils/answerWarnings';
import { AnalysisType, TimeGrain } from '../types';

// Line items: each order has 1–3 lines. Data runs to 14 Mar 2026.
function rows() {
    const out: Record<string, any>[] = [];
    const products = Array.from({ length: 30 }, (_, i) => `Product ${String(i + 1).padStart(2, '0')}`);
    let order = 1;
    const start = Date.UTC(2025, 0, 1);
    for (let d = 0; d < 438; d++) {
        const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
        for (let k = 0; k < 2; k++) {
            const lines = 1 + ((d + k) % 3);
            for (let l = 0; l < lines; l++) {
                const p = (d * 7 + k * 3 + l * 11) % 30;
                out.push({ 'Order ID': `O${order}`, 'Order Date': day, Product: products[p], Amount: 20 + ((d + l) % 15), 'Discount Rate': 0.05 * (l + 1) });
            }
            order++;
        }
    }
    return out;
}
const etl = runETLPipeline(rows(), 'Lines.csv');
const ds: any = { id: 'l', name: 'Lines.csv', rows: etl.rows, columns: etl.columns, timeContext: etl.timeContext };
const col = (re: RegExp) => etl.columns.find((c: any) => re.test(c.name))!.name;
const amount = col(/amount/); const orderId = col(/order_id/); const product = col(/product/); const rate = col(/discount/);
const asOf = '2026-03-14';
const run = (config: any) => runAnalysis(ds, { questionId: 'custom_builder', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: 'all_time', filters: {}, asOfDate: asOf, ...config } as any);
const warn = async (config: any) => answerWarnings(ds, config, await run(config), asOf);

describe('warnings before an answer misleads', () => {
    it('a month that isn’t over yet, and leaving it out', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: 'month', sort: 'oldest' };
        const [w] = (await warn(config)).filter(x => x.id === 'partial_period');
        expect(w.text).toBe('Mar 2026 only has data up to 14 Mar, so it will look lower than a full month.');
        expect(w.fixLabel).toBe('Leave out Mar 2026');
        const fixed = await run(w.fix);
        expect(fixed.data.map((r: any) => r[fixed.xKey])).not.toContain('2026-03');
        expect(fixed.data.map((r: any) => r[fixed.xKey])).toContain('2026-02');
        expect((await warn(w.fix)).some(x => x.id === 'partial_period')).toBe(false);
        // A year that is over says nothing.
        expect((await warn({ ...config, dateFilters: [{ column: col(/order_date/), timeGrain: 'year', values: ['2025'] }] })).some(x => x.id === 'partial_period')).toBe(false);
        // Averages aren't affected by a short month.
        expect((await warn({ ...config, aggregation: 'AVG' })).some(x => x.id === 'partial_period')).toBe(false);
    });
    it('a rate added up', async () => {
        const [w] = await warn({ metric: rate, aggregation: 'SUM', dimension: product });
        expect(w.id).toBe('summed_rate');
        expect(w.fix.aggregation).toBe('AVG');
        expect((await warn({ metric: amount, aggregation: 'SUM', dimension: product })).some(x => x.id === 'summed_rate')).toBe(false);
    });
    it('a top 5 that is a small part of the total', async () => {
        const config = { metric: amount, aggregation: 'SUM', dimension: product, sort: 'desc', limit: 5 };
        const w = (await warn(config)).find(x => x.id === 'top_hides_total')!;
        expect(w.text).toMatch(/^These 5 are only \d+% of the total; the other 25 product values make up the rest\.$/);
        expect(w.fixLabel).toBe('Show all 30');
        expect((await run(w.fix)).data.length).toBe(30);
        expect((await warn({ ...config, limit: 25 })).some(x => x.id === 'top_hides_total')).toBe(false);
    });
    it('counting rows where each order should count once', async () => {
        const config = { metric: orderId, aggregation: 'COUNT', dimension: 'month', sort: 'oldest' };
        const w = (await warn(config)).find(x => x.id === 'counted_rows')!;
        expect(w.fixLabel).toBe('Count each once');
        const fixed = await run(w.fix);
        const jan = fixed.data.find((r: any) => r[fixed.xKey] === '2025-01')!;
        expect(Number(jan[fixed.yKey])).toBe(62); // 2 orders a day in January
        expect((await warn(w.fix)).some(x => x.id === 'counted_rows')).toBe(false);
    });
});

describe('a short last period is told apart from data that never reaches month end', () => {
    it('stays quiet when every month stops around the 27th', async () => {
        const sparse = Array.from({ length: 12 }, (_, m) => Array.from({ length: 27 }, (_, d) => ({
            'Order Date': `2026-${String(m + 1).padStart(2, '0')}-${String(d + 1).padStart(2, '0')}`, Amount: 10,
        }))).flat();
        const e = runETLPipeline(sparse, 'Sparse.csv');
        const d: any = { id: 's', name: 'Sparse.csv', rows: e.rows, columns: e.columns, timeContext: e.timeContext };
        const a = e.columns.find((c: any) => /amount/.test(c.name))!.name;
        const config = { metric: a, aggregation: 'SUM', dimension: 'month', sort: 'oldest' };
        const result = await runAnalysis(d, { questionId: 'custom_builder', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: 'all_time', filters: {}, asOfDate: '2026-12-31', ...config } as any);
        expect(answerWarnings(d, config, result, '2026-12-31').some(w => w.id === 'partial_period')).toBe(false);
    });
});
