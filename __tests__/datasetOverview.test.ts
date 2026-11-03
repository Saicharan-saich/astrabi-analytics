import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { buildDatasetOverview } from '../services/ai-sql/datasetOverview';
import { buildDataStory } from '../services/dataStory';

const REGIONS = ['North', 'South', 'East', 'West'];
const PRODUCTS = Array.from({ length: 14 }, (_, i) => `Product ${String.fromCharCode(65 + i)}`);

/** 24 months of orders; North dominates, East collapses at the end, a spike in Jul 2025. */
function rows() {
    const out: Record<string, any>[] = [];
    let n = 0;
    for (let month = 0; month < 24; month++) {
        const date = new Date(Date.UTC(2024, month, 10)).toISOString().slice(0, 10);
        for (let k = 0; k < 40; k++) {
            n++;
            const region = REGIONS[[0, 0, 0, 1, 1, 2, 3, 3][n % 8]];
            let revenue = 100 + (n % 7) * 20 + month * 3;
            if (region === 'East' && month >= 21) revenue *= 0.2;
            if (month === 18 && region === 'West') revenue *= 6;
            out.push({ order_id: `O-${n}`, order_date: date, region, product: PRODUCTS[n % 14], revenue, profit: revenue * (region === 'North' ? 0.3 : 0.15), unit_price: 10 + (n % 5) });
        }
    }
    return out;
}

const dataset = {
    id: 'retail', name: 'retail.csv', rows: rows(), etlLogs: [], version: 1,
    columns: [
        { name: 'order_id', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
        { name: 'region', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'product', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'revenue', type: ColumnType.METRIC, originalType: 'number', currency: 'GBP' },
        { name: 'profit', type: ColumnType.METRIC, originalType: 'number', currency: 'GBP' },
        { name: 'unit_price', type: ColumnType.METRIC, originalType: 'number', currency: 'GBP' },
    ],
} as unknown as Dataset;

describe('data story — findings worked out locally', () => {
    const story = buildDataStory(dataset);
    const kinds = story.findings.map(f => f.kind);
    const find = (kind: string) => story.findings.find(f => f.kind === kind)!;

    it('never groups by an ID column, and names records after it', () => {
        expect(JSON.stringify(story.findings.map(f => f.chart?.xKey))).not.toContain('order_id');
        expect(find('overview').headline).toContain('orders');
        expect(find('overview').kpis?.[0]).toEqual({ label: 'Total revenue', value: expect.stringContaining('£') });
    });

    it('finds the trend, the spike and who caused it, and the group going against the trend', () => {
        expect(kinds[0]).toBe('overview');
        expect(kinds).toContain('trend');
        expect(find('anomaly').headline).toContain('Jul 2025');
        expect(find('anomaly').points[0]).toContain('West');
        expect(find('movers').headline).toContain('East');
    });

    it('shows where revenue comes from and the margin by group', () => {
        expect(story.findings.some(f => f.kind === 'breakdown' && f.headline.includes('North'))).toBe(true);
        expect(find('margin').headline).toMatch(/30\.0% for North/);
    });

    it('averages per-row figures such as a unit price instead of adding them up', () => {
        const priced = buildDataStory({ ...dataset, columns: dataset.columns.filter(c => c.name === 'unit_price' || c.name === 'region') } as Dataset);
        expect(priced.findings[0].headline).toContain('The average unit price');
    });

    it('scopes the story to a year named in the request', () => {
        const scoped = buildDataStory(dataset, 'Give me a summary for 2025');
        expect(scoped.scope).toBe('2025');
        expect(scoped.rowCount).toBe(480);
    });
});

describe('dataset overview in the chat', () => {
    it('uses the top findings and a chart, with no SQL', () => {
        const overview = buildDatasetOverview(dataset);
        expect(overview.title).toBe('Overview of Retail');
        expect(overview.insights.length).toBeGreaterThanOrEqual(3);
        expect(overview.analysis.sql).toBe('');
        expect(overview.analysis.data.length).toBeGreaterThan(2);
        expect(overview.formatting.numberFormat).toBe('currency_gbp');
    });
});
