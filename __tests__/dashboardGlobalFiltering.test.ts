import { describe, expect, it, vi } from 'vitest';
import { ColumnType } from '../types';
import type { DashboardItem, Dataset } from '../types';
import { filterDashboardRows } from '../utils/dashboardFilterRows';
import { resolveDashboardFilterSource } from '../utils/dashboardFilterSource';
import { rebuildDashboardItem } from '../services/dashboardRestore';

const pinnedMocks = vi.hoisted(() => ({
  refreshPinnedAISQLResult: vi.fn(async (_dataset: Dataset, previous: DashboardItem['result'], rows: Record<string, any>[]) => ({
    ...previous,
    data: [{ total_sales: rows.reduce((sum, row) => sum + row.sales, 0) }],
  })),
}));
vi.mock('../services/ai-sql/pinnedResult', () => pinnedMocks);

const columns = [
  { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
  { name: 'sales', type: ColumnType.METRIC, originalType: 'number' },
];
const rows = [
  { order_date: '2025-06-30', sales: 10 },
  { order_date: '2025-07-01', sales: 20 },
  { order_date: '2025-09-30', sales: 30 },
  { order_date: '2025-10-01', sales: 40 },
];

describe('dashboard source-level global filters', () => {
  it('reconnects a card with an old ID only when its workbook name is unique locally', () => {
    const current: Dataset = { id: 'new-upload', name: '01_Retail_Sales_RAW.xlsx', rows, totalRows: rows.length, columns, etlLogs: [] };
    const oldCard = { datasetId: 'old-upload', datasetName: current.name } as DashboardItem;
    expect(resolveDashboardFilterSource(oldCard, current, [current])).toBe(current);
    const duplicate = { ...current, id: 'another-upload' };
    expect(resolveDashboardFilterSource(oldCard, current, [current, duplicate])).toBeUndefined();
    expect(resolveDashboardFilterSource({ ...oldCard, datasetName: 'Other.xlsx' }, current, [current])).toBeUndefined();
  });

  it('uses the re-imported workbook to recalculate an old-ID pinned total', async () => {
    const current: Dataset = { id: 'new-upload', name: '01_Retail_Sales_RAW.xlsx', rows, totalRows: rows.length, columns, etlLogs: [] };
    const item = {
      id: 'old-sales', title: 'Total Sales', width: 'half', datasetId: 'old-upload', datasetName: current.name,
      result: {
        data: [{ total_sales: 100 }], xKey: 'total_sales', yKey: 'total_sales', yLabel: 'Total Sales', insight: '',
        sql: 'SELECT SUM(sales) AS total_sales FROM data', config: {} as any,
        aiSqlRefresh: { version: 1, source: 'ai-sql', sql: 'SELECT SUM(sales) AS total_sales FROM data' },
      },
    } as DashboardItem;
    const source = resolveDashboardFilterSource(item, current, [current]);
    expect(source).toBe(current);
    const filtered = filterDashboardRows(source!.rows, source!.columns, [{
      column: 'order_date', values: ['2025'], dateMode: 'calendar', dateSelection: { year: '2025', quarter: '3' },
    }]);
    const rebuilt = await rebuildDashboardItem(item, source!, filtered);
    expect(rebuilt.result.data).toEqual([{ total_sales: 50 }]);
  });

  it('keeps only the selected quarter before calculating a saved result', async () => {
    const dataset: Dataset = { id: 'retail', name: 'Retail.xlsx', rows, totalRows: rows.length, columns, etlLogs: [] };
    const item = {
      id: 'sales', title: 'Total Sales', width: 'half', datasetId: 'retail',
      result: {
        data: [{ total_sales: 100 }], xKey: 'total_sales', yKey: 'total_sales', yLabel: 'Total sales',
        insight: '', sql: 'SELECT SUM(sales) AS total_sales FROM data',
        config: {} as any,
        aiSqlRefresh: { version: 1, source: 'ai-sql', sql: 'SELECT SUM(sales) AS total_sales FROM data' },
      },
    } as DashboardItem;
    const filtered = filterDashboardRows(rows, columns, [{
      column: 'order_date', type: 'dimension', values: ['2025'],
      dateMode: 'calendar', dateSelection: { year: '2025', quarter: '3' },
    }]);
    expect(filtered.map(row => row.sales)).toEqual([20, 30]);
    const rebuilt = await rebuildDashboardItem(item, dataset, filtered);
    expect(pinnedMocks.refreshPinnedAISQLResult).toHaveBeenCalledWith(dataset, item.result, filtered);
    expect(rebuilt.result.data).toEqual([{ total_sales: 50 }]);
    expect(item.result.data).toEqual([{ total_sales: 100 }]);
  });

  it('returns no rows for an unmatched range and combines date and measure predicates', () => {
    expect(filterDashboardRows(rows, columns, [{
      column: 'order_date', values: ['2024-01-01', '2024-12-31'],
      dateMode: 'range', dateRange: { from: '2024-01-01', to: '2024-12-31' },
    }])).toEqual([]);
    expect(filterDashboardRows(rows, columns, [
      { column: 'order_date', values: ['2025'], dateMode: 'calendar', dateSelection: { year: '2025', quarter: '3' } },
      { column: 'sales', type: 'measure', values: [], operator: '>', numericValue: 20 },
    ])).toEqual([rows[2]]);
  });
});
