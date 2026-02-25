import { describe, it, expect } from 'vitest';
import { parseNLQ } from '../services/nlqParser';
import { Dataset, ColumnType, AggregationType, TimeGrain } from '../types';

/**
 * Minimal test dataset simulating a Superstore-style schema.
 * Only the columns array and timeContext are needed for parser testing.
 */
const makeTestDataset = (): Dataset => ({
    id: 'test-1',
    name: 'Test Dataset',
    columns: [
        { name: 'Sales', type: ColumnType.METRIC, originalType: 'number' },
        { name: 'Profit', type: ColumnType.METRIC, originalType: 'number' },
        { name: 'Quantity', type: ColumnType.METRIC, originalType: 'number' },
        { name: 'Region', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'Category', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'Customer Name', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'Product Name', type: ColumnType.DIMENSION, originalType: 'string' },
        { name: 'Order Date', type: ColumnType.DATE, originalType: 'date' },
    ],
    rows: [],
    totalRows: 0,
    etlLogs: [],
    timeContext: {
        minDate: '2020-01-01',
        maxDate: '2024-12-31',
        defaultAnchorDate: '2024-12-31',
        anchorDateColumn: 'Order Date',
        dateColumnMaxDates: { 'Order Date': '2024-12-31' },
    },
});

describe('NLQ Parser', () => {

    describe('basic metric and dimension parsing', () => {
        it('parses "total sales by region"', () => {
            const result = parseNLQ('total sales by region', makeTestDataset());
            expect(result.metric).toBe('Sales');
            expect(result.dimension).toBe('Region');
            expect(result.aggregation).toBe(AggregationType.SUM);
        });

        it('parses "average profit by category"', () => {
            const result = parseNLQ('average profit by category', makeTestDataset());
            expect(result.metric).toBe('Profit');
            expect(result.dimension).toBe('Category');
            expect(result.aggregation).toBe(AggregationType.AVG);
        });

        it('parses "how many orders by region"', () => {
            const result = parseNLQ('how many orders by region', makeTestDataset());
            expect(result.aggregation).toBe(AggregationType.COUNT);
            expect(result.dimension).toBe('Region');
        });
    });

    describe('"X wise" pattern', () => {
        it('parses "region wise sales"', () => {
            const result = parseNLQ('region wise sales', makeTestDataset());
            expect(result.metric).toBe('Sales');
            expect(result.dimension).toBe('Region');
        });

        it('does NOT interpret "sales wise" as dimension = Sales', () => {
            const result = parseNLQ('top 5 customers sales wise', makeTestDataset());
            // "sales" is a metric word — should NOT be picked as dimension
            expect(result.dimension).not.toBe('Sales');
        });
    });

    describe('table calculation detection', () => {
        it('detects "running total"', () => {
            const result = parseNLQ('running total of sales by region', makeTestDataset());
            expect(result.tableCalculations).toContain('running_total');
        });

        it('detects "cumulative" as running total', () => {
            const result = parseNLQ('cumulative sales by month', makeTestDataset());
            expect(result.tableCalculations).toContain('running_total');
        });

        it('detects "% of total"', () => {
            const result = parseNLQ('% of total sales by region', makeTestDataset());
            expect(result.tableCalculations).toContain('percent_of_total');
        });

        it('detects "rank"', () => {
            const result = parseNLQ('rank products by sales', makeTestDataset());
            expect(result.tableCalculations).toContain('rank_desc');
        });

        it('detects "% change"', () => {
            const result = parseNLQ('% change in profit by month', makeTestDataset());
            expect(result.tableCalculations).toContain('pct_diff_from_prev');
        });

        it('detects "moving average"', () => {
            const result = parseNLQ('moving average of sales by month', makeTestDataset());
            expect(result.tableCalculations).toContain('moving_avg');
        });

        it('returns empty array when no table calc keywords', () => {
            const result = parseNLQ('total sales by region', makeTestDataset());
            expect(result.tableCalculations).toEqual([]);
        });
    });

    describe('entity word dimension detection', () => {
        it('"customers" matches Customer Name column', () => {
            const result = parseNLQ('top 5 customers by sales', makeTestDataset());
            expect(result.dimension).toBe('Customer Name');
        });

        it('"products" matches Product Name column', () => {
            const result = parseNLQ('top products by profit', makeTestDataset());
            expect(result.dimension).toBe('Product Name');
        });
    });

    describe('sort and limit', () => {
        it('detects "top 5"', () => {
            const result = parseNLQ('top 5 categories by sales', makeTestDataset());
            expect(result.limit).toBe(5);
            expect(result.sort).toBe('desc');
        });

        it('detects "bottom 10"', () => {
            const result = parseNLQ('bottom 10 products by profit', makeTestDataset());
            expect(result.limit).toBe(10);
            expect(result.sort).toBe('asc');
        });
    });

    describe('time grain detection', () => {
        it('detects "by month"', () => {
            const result = parseNLQ('sales by month', makeTestDataset());
            expect(result.timeGrain).toBe(TimeGrain.MONTH);
        });

        it('detects "by year"', () => {
            const result = parseNLQ('profit by year', makeTestDataset());
            expect(result.timeGrain).toBe(TimeGrain.YEAR);
        });
    });

    describe('robustness — garbage input', () => {
        it('does not crash on empty string', () => {
            const result = parseNLQ('', makeTestDataset());
            expect(result.confidence).toBe(0);
            expect(result.explanation).toContain('Empty or invalid query.');
        });

        it('does not crash on null', () => {
            const result = parseNLQ(null as any, makeTestDataset());
            expect(result.confidence).toBe(0);
        });

        it('does not crash on very long input', () => {
            const longInput = 'sales '.repeat(500);
            const result = parseNLQ(longInput, makeTestDataset());
            expect(result.metric).toBeTruthy();
        });

        it('does not crash on special characters', () => {
            const result = parseNLQ('sales ><= & $ # @ !!! by region', makeTestDataset());
            expect(result.metric).toBe('Sales');
        });

        it('does not crash on gibberish', () => {
            const result = parseNLQ('asdfghjkl zxcvbnm qwertyuiop', makeTestDataset());
            expect(result).toBeDefined();
            expect(result.confidence).toBeLessThan(1);
        });
    });

    describe('aggregation keywords', () => {
        it('detects "max" / "maximum"', () => {
            const result = parseNLQ('maximum sales by region', makeTestDataset());
            expect(result.aggregation).toBe(AggregationType.MAX);
        });

        it('detects "min" / "minimum"', () => {
            const result = parseNLQ('minimum profit by category', makeTestDataset());
            expect(result.aggregation).toBe(AggregationType.MIN);
        });

        it('detects "count"', () => {
            const result = parseNLQ('count of sales by category', makeTestDataset());
            expect(result.aggregation).toBe(AggregationType.COUNT);
        });
    });
});
