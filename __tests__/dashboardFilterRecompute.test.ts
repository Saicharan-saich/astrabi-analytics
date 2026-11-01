import { describe, expect, it } from 'vitest';
import { rebuildDashboardItem } from '../services/dashboardRestore';

const rows = [
    { order_id: 'O1', order_date: '2024-01-05', category: 'Electronics', revenue: 100 },
    { order_id: 'O2', order_date: '2024-01-09', category: 'Electronics', revenue: 50 },
    { order_id: 'O3', order_date: '2024-02-03', category: 'Apparel', revenue: 30 },
    { order_id: 'O4', order_date: '2024-02-07', category: 'Toys', revenue: 20 },
];
const dataset: any = {
    id: 'ds', name: 'Sales', version: 1, rows, totalRows: rows.length, etlLogs: [],
    timeContext: { minDate: '2024-01-05', maxDate: '2024-02-07', defaultAnchorDate: '2024-02-07', anchorDateColumn: 'order_date', dateColumnMaxDates: {} },
    columns: [
        { name: 'order_id', type: 'ID', originalType: 'string' },
        { name: 'order_date', type: 'DATE', originalType: 'string' },
        { name: 'category', type: 'DIMENSION', originalType: 'string' },
        { name: 'revenue', type: 'METRIC', originalType: 'number' },
    ],
};

const card = (config: any): any => ({
    id: 'card', title: 'Card', width: 'half',
    result: {
        data: [], xKey: 'category', yKey: 'revenue', yLabel: 'Revenue', insight: '', sql: '',
        config: { questionId: 'custom_builder', timeGrain: 'Raw Date', analysisType: 'Standard', ...config },
        queryConfig: { questionId: 'custom_builder', timeGrain: 'Raw Date', analysisType: 'Standard', ...config },
    },
});

const total = (data: any[]) => data.reduce((sum, row) => {
    const value = Object.entries(row).find(([k, v]) => typeof v === 'number' && !/previous|growth/.test(k))?.[1] as number;
    return sum + (value || 0);
}, 0);

describe('dashboard filters re-run Builder cards on the filtered rows', () => {
    it('sums only the rows that pass the filter', async () => {
        const january = rows.filter(r => r.order_date.startsWith('2024-01'));
        const rebuilt = await rebuildDashboardItem(card({ metric: 'revenue', dimension: 'category', aggregation: 'SUM' }), dataset, january);
        expect(total(rebuilt.result.data)).toBe(150);
        expect(rebuilt.result.data).toHaveLength(1);
    });

    it('counts distinct text IDs', async () => {
        const february = rows.filter(r => r.order_date.startsWith('2024-02'));
        const rebuilt = await rebuildDashboardItem(card({ metric: 'order_id', dimension: 'category', aggregation: 'COUNT_DISTINCT' }), dataset, february);
        expect(total(rebuilt.result.data)).toBe(2);
    });
});
