import { describe, expect, it } from 'vitest';
import { exampleQuestions, questionFromWords } from '../services/builderFromWords';
import { runETLPipeline } from '../services/etlPipeline';
import { runAnalysis } from '../services/analysisEngine';
import { AnalysisType, TimeGrain, type Dataset } from '../types';

const items = [['Classic Burger', 'Mains', 14], ['Steak Frites', 'Mains', 22], ['Fries', 'Sides', 4], ['Fresh Lemonade', 'Drinks', 3.5]] as const;
const raw = Array.from({ length: 400 }, (_, i) => {
    const [item, cat, p] = items[i % 4];
    return {
        'Order ID': `R${i}`, 'Order Date': `2026-0${1 + (i % 9)}-1${i % 9}`, Location: ['Leeds', 'York', 'Hull'][i % 3], 'Service Type': ['Dine-In', 'Delivery'][i % 2],
        'Menu Category': cat, 'Menu Item': item, Quantity: 1 + (i % 3), 'Gross Sales': p * (1 + (i % 3)), 'Food Cost': p * 0.3, 'Customer Rating': 3 + (i % 3),
    };
});
const out = runETLPipeline(raw, 'restaurant.csv');
const ds = { id: 'r', name: 'restaurant.csv', rows: out.rows, columns: out.columns, timeContext: out.timeContext } as unknown as Dataset;
const AS_OF = '2026-09-20';
const ask = (q: string) => questionFromWords(ds, q, AS_OF);

describe('a question in words becomes a builder question', () => {
    it.each([
        ['sales by location', { metric: 'gross_sales', aggregation: 'SUM', dimension: 'location', sort: 'desc' }],
        ['top 5 menu items by sales', { metric: 'gross_sales', dimension: 'menu_item', limit: 5, sort: 'desc' }],
        ['lowest 3 items by quantity', { metric: 'quantity', dimension: 'menu_item', limit: -3, sort: 'asc' }],
        ['average rating by service type', { metric: 'customer_rating', aggregation: 'AVG', dimension: 'service_type' }],
        ['how many orders by location', { metric: 'order_id', aggregation: 'COUNT_DISTINCT', dimension: 'location' }],
        ['sales by location and service type', { dimension: 'location', secondaryDimensions: ['service_type'] }],
        ['sales by month for each location', { dimension: 'month', secondaryDimensions: ['location'], sort: 'oldest' }],
        ['sales and food cost by month', { metric: 'gross_sales', secondaryMetrics: ['food_cost'], dimension: 'month' }],
        ['sales in Leeds last 3 months', { timeFilter: 'last_3_months', filters: { location: ['Leeds'] } }],
        ['food cost by category excluding drinks', { metric: 'food_cost', dimension: 'menu_category', filters: { menu_category: ['Mains', 'Sides'] } }],
        ['which location sells the most burgers', { dimension: 'location', sort: 'desc', filters: { menu_item: ['Classic Burger'] } }],
        ['sales this month vs last month', { timeFilter: 'this_month', comparison: 'previous_period' }],
        ['sales by item year on year', { comparison: 'same_period_last_n', comparisonGrain: 'year', comparisonOffset: 1 }],
        ['sales last month', { dateFilters: [{ column: 'order_date', timeGrain: 'month', values: ['2026-08'] }] }],
        ['q2 sales by store', { dimension: 'location', dateFilters: [{ column: 'order_date', timeGrain: 'quarter', values: ['2026-Q2'] }] }],
        ['what is the trend of ratings', { metric: 'customer_rating', aggregation: 'AVG', dimension: 'month' }],
    ])('%s', (question, expected) => {
        const r = ask(question);
        expect(r.config).toMatchObject(expected);
        expect(r.unused).toEqual([]);
    });

    it('says what it understood, in order, and what it could not use', () => {
        const r = ask('top 5 menu items by sales in Leeds last 3 months');
        expect(r.understood.map(u => u.text)).toEqual(['total gross sales', 'by menu item', 'the last 3 months', 'top 5', 'only Leeds (location)']);
        const odd = ask('show me profit by zebra');
        expect(odd.unused).toEqual(['profit', 'zebra']);
        expect(odd.usedDefaultMeasure).toBe(true);
        expect(odd.understood[0].text).toBe('total gross sales (your main amount)');
        // "customers" is not a column here: never matched to customer rating.
        expect(ask('how many customers').config.metric).not.toBe('customer_rating');
    });

    it('gives example questions that are fully understood', () => {
        const examples = exampleQuestions(ds, AS_OF);
        expect(examples.length).toBeGreaterThanOrEqual(2);
        for (const q of examples) expect(ask(q).unused).toEqual([]);
    });

    it('produces answers the engine computes correctly', async () => {
        const run = async (q: string) => {
            const c = ask(q).config as any;
            return runAnalysis(ds, { questionId: 'custom_builder', metric: c.metric, dimension: c.dimension, aggregation: c.aggregation, timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD, timeFilter: c.timeFilter, filters: c.filters, dateFilters: c.dateFilters, limit: c.limit, sort: c.sort, asOfDate: AS_OF } as any);
        };
        const byLocation = await run('sales in Leeds by location');
        const leeds = out.rows.filter(r => r.location === 'Leeds').reduce((s, r) => s + r.gross_sales, 0);
        expect(byLocation.data).toHaveLength(1);
        expect(Number(Object.values(byLocation.data[0]).find(v => typeof v === 'number'))).toBeCloseTo(leeds, 2);

        const top = await run('top 2 menu items by sales');
        expect(top.data).toHaveLength(2);
        const totals = new Map<string, number>();
        for (const r of out.rows) totals.set(r.menu_item, (totals.get(r.menu_item) || 0) + r.gross_sales);
        const best = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
        expect(top.data.map((d: any) => d[top.xKey])).toEqual(best);

        const orders = await run('how many orders by location');
        const yorkOrders = new Set(out.rows.filter(r => r.location === 'York').map(r => r.order_id)).size;
        expect(orders.data.find((d: any) => d[orders.xKey] === 'York')?.[orders.yKey]).toBe(yorkOrders);
    });
});
