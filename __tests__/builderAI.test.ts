/**
 * The AI sets up the Question Builder: it sees the question and the file's
 * column names and kinds, never rows or values; whatever it returns is checked
 * against the file; filter words are matched to real values here; and if it
 * can't be reached the question is read on this computer.
 */
import { describe, expect, it } from 'vitest';
import { planFromQuestion, checkAISettings, builderMetadata, groundValue, describeSettings } from '../services/builderAI';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { describeComparison } from '../utils/builderAnswer';
import { AnalysisType, TimeGrain, type Dataset } from '../types';

const items = [['Classic Burger', 'Mains', 14], ['Steak Frites', 'Mains', 22], ['Fries', 'Sides', 4], ['Fresh Lemonade', 'Drinks', 3.5]] as const;
const raw = Array.from({ length: 600 }, (_, i) => {
    const [item, cat, p] = items[i % 4];
    return {
        'Order ID': `R${i}`, 'Order Date': `2026-0${7 + (i % 3)}-${String(1 + (i % 28)).padStart(2, '0')}`, Location: ['Leeds', 'York', 'Hull'][i % 3],
        'Menu Category': cat, 'Menu Item': item, Quantity: 1 + (i % 3), 'Gross Sales': p * (1 + (i % 3)),
    };
});
const out = runETLPipeline(raw, 'restaurant.csv');
const ds = { id: 'r', name: 'restaurant.csv', rows: out.rows, columns: out.columns, timeContext: out.timeContext } as unknown as Dataset;
const AS_OF = '2026-09-20';

describe('the AI sets up the builder', () => {
    it('sends the question and column descriptions, never a value from the file', async () => {
        let sent = '';
        const plan = await planFromQuestion(ds, 'compare this and last month sales', AS_OF, async messages => {
            sent = JSON.stringify(messages);
            return JSON.stringify({ metric: 'gross_sales', aggregation: 'SUM', dimension: 'day', timeFilter: 'this_month', comparison: 'previous_period', comparisonGrain: 'month', sort: 'oldest', reading: 'This month so far next to last month, day by day.' });
        });
        for (const value of ['Classic Burger', 'Leeds', 'Mains', 'R12', '2026-08-03']) expect(sent).not.toContain(value);
        expect(sent).toContain('gross_sales');
        expect(sent).toContain('compare this and last month sales');
        expect(plan.source).toBe('ai');
        expect(plan.config).toMatchObject({ metric: 'gross_sales', dimension: 'day', timeFilter: 'this_month', comparison: 'previous_period', comparisonGrain: 'month', comparisonOffset: 1 });
        expect(plan.understood.map(u => u.slot)).toEqual(['measure', 'split', 'time', 'compare']);
    });
    it('the comparison it sets up runs, with both months on the chart and a sentence saying the change', async () => {
        const plan = await planFromQuestion(ds, 'compare this and last month sales', AS_OF, async () => JSON.stringify({ metric: 'gross_sales', aggregation: 'SUM', dimension: 'day', timeFilter: 'this_month', comparison: 'previous_period', comparisonGrain: 'month', sort: 'oldest' }));
        const result: any = await runAnalysis(ds, { questionId: 'custom_builder', timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, filters: {}, asOfDate: AS_OF, ...plan.config } as any);
        expect(result.data.length).toBeGreaterThan(5);
        expect(result.data.every((r: any) => String(r[result.xKey]).startsWith('2026-09'))).toBe(true);
        expect(result.data.some((r: any) => r.previous_value !== undefined)).toBe(true);
        // September 1–20 against August 1–20, worked out by hand.
        const sum = (month: string) => out.rows.filter((r: any) => String(r.order_date).startsWith(month) && Number(String(r.order_date).slice(8, 10)) <= 20).reduce((s: number, r: any) => s + r.gross_sales, 0);
        const fmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 2 });
        expect(describeComparison(result)).toContain(`In total: ${fmt(sum('2026-09'))} against ${fmt(sum('2026-08'))} in the same days of the month before`);
    });
    it('checks what comes back: unknown columns, settings and periods are dropped and said', () => {
        const { config, notes, calculation } = checkAISettings(ds, {
            metric: 'gross_sales', aggregation: 'TOTALISE', dimension: 'postcode', timeFilter: 'last_fortnight',
            dateFilters: [{ grain: 'month', values: ['2026-13'] }, { grain: 'quarter', values: ['2026-Q2'] }],
            secondaryDimensions: ['location', 'nope'], comparison: 'sideways', calculation: 'percent_of_total', limit: 'ten',
        });
        expect(config).toMatchObject({ metric: 'gross_sales', aggregation: 'SUM', timeFilter: 'all_time', dateFilters: [{ column: 'order_date', timeGrain: 'quarter', values: ['2026-Q2'] }], secondaryDimensions: ['location'] });
        expect(config.dimension).toBeUndefined();
        expect(config.comparison).toBeUndefined();
        expect(config.limit).toBeUndefined();
        expect(notes).toContain('Couldn’t split by “postcode”.'.replace('’', "'"));
        expect(calculation).toBeNull(); // nothing to calculate across without a split
    });
    it('matches filter words to the file’s values here, and says when one isn’t there', () => {
        const { config, notes } = checkAISettings(ds, { metric: 'gross_sales', dimension: 'location', filters: { menu_item: ['burgers'], location: ['zebra'] }, exclude: { menu_category: ['drinks'] } });
        expect(config.filters).toEqual({ menu_item: ['Classic Burger'], menu_category: ['Mains', 'Sides'] });
        expect(notes).toContain("“zebra” isn't a location in this file.");
        expect(groundValue(['Fresh Lemonade', 'Lemon Tart'], 'lemonade')).toEqual(['Fresh Lemonade']);
    });
    it('sets the Calc tab when asked for a share', async () => {
        const plan = await planFromQuestion(ds, 'share of sales by category', AS_OF, async () => '```json\n{"metric":"gross_sales","dimension":"menu_category","calculation":"percent_of_total"}\n```');
        expect(plan.calculation).toBe('percent_of_total');
        expect(describeSettings(plan.config, plan.calculation).find(u => u.slot === 'calc')?.text).toBe('share of the total');
    });
    it('reads the question on this computer when the AI can’t be reached', async () => {
        const plan = await planFromQuestion(ds, 'compare this and last month sales', AS_OF, async () => { throw new Error('offline'); });
        expect(plan.source).toBe('local');
        expect(plan.fallbackReason).toBe('offline');
        expect(plan.config).toMatchObject({ metric: 'gross_sales', timeFilter: 'this_month', comparison: 'previous_period', dimension: 'day' });
    });
    it('describes the file without rows', () => {
        const meta = builderMetadata(ds, AS_OF);
        expect(meta).toMatchObject({ rows: 600, asOf: AS_OF, dateColumn: 'order_date', datesFrom: '2026-07-01', datesTo: '2026-09-28' });
        expect(meta.columns.find(c => c.name === 'menu_item')).toEqual({ name: 'menu_item', kind: 'category', differentValues: 4 });
    });
});
