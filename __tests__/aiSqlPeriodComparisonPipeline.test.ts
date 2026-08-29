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

describe('AI SQL model-owned period-comparison route', () => {
    it('gives the LLM schema facts and executes its model-authored two-period SQL without deterministic replacement', async () => {
        directSqlMocks.generateDirectSQL.mockClear();
        directSqlMocks.executeSQLViaDuckDB.mockClear();
        directSqlMocks.generateDirectSQL.mockResolvedValue({
            sql: `WITH periods AS (
                SELECT DATE_TRUNC('month', CAST(order_date AS DATE)) AS period_month,
                       SUM(amount) AS amount_sum
                FROM data
                WHERE CAST(order_date AS DATE) >= DATE '2025-02-01'
                  AND CAST(order_date AS DATE) < DATE '2025-04-01'
                GROUP BY 1
            ), compared AS (
                SELECT period_month, amount_sum,
                       LAG(amount_sum) OVER (ORDER BY period_month) AS previous_amount
                FROM periods
            )
            SELECT CASE WHEN period_month = DATE '2025-03-01' THEN 'Current' ELSE 'Previous' END AS period,
                   amount_sum,
                   100.0 * (amount_sum - previous_amount) / NULLIF(previous_amount, 0) AS growth_pct
            FROM compared
            ORDER BY period_month DESC`,
            tokens: 30,
            model: 'terra → luna → sol',
            querySpec: {
                goal: 'Compare current and previous month sales totals',
                operations: {
                    measures: [{ field: 'amount', aggregation: 'sum' }],
                    filters: [{
                        field: 'order_date',
                        operator: 'between',
                        value: ['2025-03-01', '2025-03-31'],
                    }],
                    tableCalculations: [{
                        type: 'period_growth',
                        orderBy: ['period_month'],
                        outputAlias: 'growth_pct',
                        required: true,
                    }],
                },
                expectedResult: { grain: 'one row per comparison period', columns: ['period', 'amount_sum', 'growth_pct'] },
                assumptions: [],
            },
        });
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
            'Compare this and last month sales',
            dataset,
        );

        expect(directSqlMocks.generateDirectSQL).toHaveBeenCalledOnce();
        expect(directSqlMocks.executeSQLViaDuckDB).toHaveBeenCalled();
        const executedSql = String((directSqlMocks.executeSQLViaDuckDB.mock.calls as any[][])[0]?.[1] || '');
        expect(executedSql).toMatch(/^WITH periods/i);
        expect(executedSql).toMatch(/\bLAG\s*\(/i);
        expect(executedSql).toMatch(/\bgrowth_pct\b/i);
        expect(executedSql).not.toMatch(/GROUP BY\s+.*order_id/i);
        expect(result.engine).toBe('llm-sql');
        expect(result.tokenUsage.total).toBe(30);
        expect(result.plan.intent).toBe('total_comparison');
        expect(result.plan.metrics).toEqual([expect.objectContaining({ field: 'amount', agg: 'sum' })]);
        expect(result.plan.dimensions).toEqual([]);
        expect(result.plan.filters).toContainEqual(expect.objectContaining({
            field: 'order_date',
            op: 'between',
            value: ['2025-03-01', '2025-03-31'],
        }));
        expect(result.rawData).toHaveLength(2);
        expect(result.rawData.map(row => row.period)).toEqual(['Current', 'Previous']);
        expect(result.rawData.some(row => 'order_id' in row)).toBe(false);
        expect(result.chartData.map(row => row.period)).toEqual(['This Month', 'Last Month']);
        expect(result.chart.growth?.pct).toBe(100);
    });
});
