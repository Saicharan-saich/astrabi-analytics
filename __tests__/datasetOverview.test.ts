import { describe, expect, it } from 'vitest';
import { ColumnType, type Dataset } from '../types';
import { buildDatasetOverview } from '../services/ai-sql/datasetOverview';

const rows = [
    { region: 'North', product: 'Kettle', revenue: 100, order_date: '2024-01-03' },
    { region: 'South', product: 'Toaster', revenue: 300, order_date: '2024-02-11' },
    { region: 'North', product: 'Kettle', revenue: 50, order_date: '2024-03-21' },
    { region: 'East', product: null, revenue: 50, order_date: '2024-03-28' },
];
const dataset = {
    id: 'retail', name: 'retail.csv', rows, totalRows: rows.length, etlLogs: [], version: 1,
    columns: [
        { name: 'region', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'product', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'revenue', type: ColumnType.METRIC, originalType: 'number', currency: 'GBP' },
        { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
    ],
} as unknown as Dataset;

describe('dataset overview — worked out locally, no AI', () => {
    it('describes size, total, spread, trend and gaps from every row', () => {
        const overview = buildDatasetOverview(dataset);
        expect(overview.title).toBe('Overview of retail');
        expect(overview.summary).toContain('4 rows and 4 columns');
        expect(overview.summary).toContain('Jan 2024 to Mar 2024');
        expect(overview.insights[0]).toBe('Total revenue is £500, an average of £125 per row.');
        expect(overview.insights.some(line => line.startsWith('By '))).toBe(true);
        expect(overview.insights.some(line => line.includes('peaked in Feb 2024'))).toBe(true);
        expect(overview.insights.some(line => line.includes('product (25% blank)'))).toBe(true);
        expect(overview.analysis.sql).toBe('');
        expect(overview.analysis.vis).toBe('area');
        expect(overview.analysis.data).toHaveLength(3);
        expect(overview.formatting.numberFormat).toBe('currency_gbp');
    });

    it('falls back to a bar chart by the main grouping when there is no date', () => {
        const noDates = { ...dataset, columns: dataset.columns.filter(c => c.name !== 'order_date') } as Dataset;
        const overview = buildDatasetOverview(noDates);
        expect(overview.analysis.vis).toBe('bar');
        expect(typeof overview.analysis.data[0].total_revenue).toBe('number');
    });
});
