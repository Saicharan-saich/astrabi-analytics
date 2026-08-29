import { describe, expect, it, vi } from 'vitest';
import { ColumnType, type Dataset } from '../types';

const compoundMocks = vi.hoisted(() => ({
    generateDirectSQL: vi.fn(),
    executeSQLViaDuckDB: vi.fn(async () => ({
        data: [
            { category: 'Office Supplies', sales: 2089510, percentage_of_total_sales: 33.8, sales_rank: 1, cumulative_sales_percentage: 33.8 },
            { category: 'Electronics', sales: 2054456, percentage_of_total_sales: 33.2, sales_rank: 2, cumulative_sales_percentage: 67.0 },
            { category: 'Furniture', sales: 2038673, percentage_of_total_sales: 33.0, sales_rank: 3, cumulative_sales_percentage: 100 },
        ],
        columns: ['category', 'sales', 'percentage_of_total_sales', 'sales_rank', 'cumulative_sales_percentage'],
        error: null,
    })),
}));

vi.mock('../services/ai-sql/directSqlEngine', async importOriginal => ({
    ...(await importOriginal<typeof import('../services/ai-sql/directSqlEngine')>()),
    generateDirectSQL: compoundMocks.generateDirectSQL,
}));

vi.mock('../services/duckdbEngine', async importOriginal => ({
    ...(await importOriginal<typeof import('../services/duckdbEngine')>()),
    executeSQLViaDuckDB: compoundMocks.executeSQLViaDuckDB,
}));

import { runAISQLPipeline } from '../services/ai-sql/pipeline';

describe('AI SQL compound analytical result preservation', () => {
    it('keeps every model-authored output and recommends a mixed-scale combo chart', async () => {
        compoundMocks.generateDirectSQL.mockResolvedValue({
            sql: `WITH category_sales AS (
                SELECT category, SUM(amount) AS sales FROM data GROUP BY category
            )
            SELECT category, sales,
                   sales / NULLIF(SUM(sales) OVER (), 0) * 100 AS percentage_of_total_sales,
                   RANK() OVER (ORDER BY sales DESC) AS sales_rank,
                   SUM(sales) OVER (ORDER BY sales DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                     / NULLIF(SUM(sales) OVER (), 0) * 100 AS cumulative_sales_percentage
            FROM category_sales ORDER BY sales DESC`,
            tokens: 40,
            model: 'terra → luna → sol',
            querySpec: {
                goal: 'Show category sales, contribution, rank, and cumulative contribution',
                operations: {
                    measures: [{ field: 'amount', aggregation: 'sum' }],
                    groupBy: [{ field: 'category' }],
                    orderBy: [{ expression: 'sales', direction: 'desc' }],
                    ratio: {
                        kind: 'percentage',
                        basis: 'measure',
                        numerator: { description: 'category sales' },
                        denominator: { description: 'all category sales' },
                        scale: 100,
                    },
                    tableCalculations: [
                        { type: 'rank', orderBy: ['sales DESC'], outputAlias: 'sales_rank', required: true },
                        { type: 'cumulative_percentage', orderBy: ['sales DESC'], outputAlias: 'cumulative_sales_percentage', required: true },
                    ],
                },
                expectedResult: {
                    grain: 'one row per category',
                    columns: ['category', 'sales', 'percentage_of_total_sales', 'sales_rank', 'cumulative_sales_percentage'],
                },
                assumptions: [],
            },
        });

        const rows = [
            { order_id: 'A', category: 'Office Supplies', amount: 100 },
            { order_id: 'B', category: 'Electronics', amount: 90 },
            { order_id: 'C', category: 'Furniture', amount: 80 },
        ];
        const dataset: Dataset = {
            id: 'compound-result',
            name: 'Sales Dataset.csv',
            rows,
            columns: [
                { name: 'order_id', type: ColumnType.ID, originalType: 'string' },
                { name: 'category', type: ColumnType.DIMENSION, originalType: 'string' },
                { name: 'amount', type: ColumnType.METRIC, originalType: 'number' },
            ],
            totalRows: rows.length,
            etlLogs: [],
        };

        const result = await runAISQLPipeline(
            "Show each category's sales, percentage of total sales, rank, and cumulative sales percentage.",
            dataset,
        );

        const expectedColumns = [
            'category',
            'sales',
            'percentage_of_total_sales',
            'sales_rank',
            'cumulative_sales_percentage',
        ];
        expect(Object.keys(result.rawData[0])).toEqual(expectedColumns);
        expect(Object.keys(result.chartData[0])).toEqual(expectedColumns);
        expect(result.chart).toMatchObject({
            chartType: 'dualAxisCombo',
            xKey: 'category',
            yKey: 'sales',
            secondaryYKeys: ['percentage_of_total_sales', 'cumulative_sales_percentage'],
            useDualAxis: true,
            rightAxisFormat: 'percent',
        });
        expect(result.chart.secondaryYKeys).not.toContain('sales_rank');
    });
});
