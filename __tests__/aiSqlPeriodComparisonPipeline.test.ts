import { describe, expect, it, vi } from 'vitest';
import { ColumnType, type Dataset } from '../types';

const directSqlMocks = vi.hoisted(() => ({
    generateDirectSQL: vi.fn(),
    executeSQLViaDuckDB: vi.fn(async () => ({
        data: [
            { period: 'Current', amount_sum: 600 },
            { period: 'Previous', amount_sum: 300 },
        ],
        columns: ['period', 'amount_sum'],
        error: null,
    })),
}));

vi.mock('../services/ai-sql/directSqlEngine', async importOriginal => ({
    ...(await importOriginal<typeof import('../services/ai-sql/directSqlEngine')>()),
    generateDirectSQL: directSqlMocks.generateDirectSQL,
}));

vi.mock('../services/duckdbEngine', async importOriginal => ({
    ...(await importOriginal<typeof import('../services/duckdbEngine')>()),
    executeSQLViaDuckDB: directSqlMocks.executeSQLViaDuckDB,
}));

import { runAISQLPipeline } from '../services/ai-sql/pipeline';

describe('AI SQL deterministic period-comparison route', () => {
    it('returns two monthly totals and never lets direct SQL add order_id', async () => {
        directSqlMocks.generateDirectSQL.mockClear();
        directSqlMocks.executeSQLViaDuckDB.mockClear();
        const rows = [
            { order_id: 'F-1', order_date: '2025-02-03', amount: 100 },
            { order_id: 'F-2', order_date: '2025-02-20', amount: 200 },
            { order_id: 'M-1', order_date: '2025-03-02', amount: 250 },
            { order_id: 'M-2', order_date: '2025-03-15', amount: 350 },
        ];
        const dataset: Dataset = {
            id: 'period-comparison',
            name: 'Sales Dataset.csv',
            rows,
            columns: [
                { name: 'order_id', type: ColumnType.ID, originalType: 'string' },
                { name: 'order_date', type: ColumnType.DATE, originalType: 'string' },
                { name: 'amount', type: ColumnType.METRIC, originalType: 'number' },
            ],
            totalRows: rows.length,
            etlLogs: [],
            timeContext: {
                minDate: '2025-02-03',
                maxDate: '2025-03-15',
                defaultAnchorDate: '2025-03-15',
                anchorDateColumn: 'order_date',
                dateColumnMaxDates: { order_date: '2025-03-15' },
            },
        };

        const result = await runAISQLPipeline(
            'show the comparision between this month and last month sales',
            dataset,
        );

        expect(directSqlMocks.generateDirectSQL).not.toHaveBeenCalled();
        expect(directSqlMocks.executeSQLViaDuckDB).toHaveBeenCalled();
        expect(result.engine).toBe('correction-engine');
        expect(result.tokenUsage.total).toBe(0);
        expect(result.rawData).toHaveLength(2);
        expect(result.rawData.map(row => row.period)).toEqual(['Current', 'Previous']);
        expect(result.rawData.some(row => 'order_id' in row)).toBe(false);
        expect(result.chartData.map(row => row.period)).toEqual(['This Month', 'Last Month']);
        expect(result.chart.growth?.pct).toBe(100);
    });
});
