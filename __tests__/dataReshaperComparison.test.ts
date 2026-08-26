import { describe, expect, it } from 'vitest';
import { reshapeData } from '../services/ai-sql/dataReshaper';

describe('AI SQL total-period presentation', () => {
    it('presents exactly This Month and Last Month without a source-record grain', () => {
        const result = reshapeData(
            [
                { period: 'Current', amount_sum: 60_000, growth_pct: 20 },
                { period: 'Previous', amount_sum: 50_000, growth_pct: null },
            ],
            {
                rowCount: 2,
                columnCount: 3,
                metricCount: 1,
                dimensionCount: 1,
                dimensionColumns: ['period'],
                metricColumns: ['amount_sum'],
                dimensionCardinality: { period: 2 },
                hasTimeDimension: false,
                metricsScaleMismatch: 1,
                metricSemanticTypes: {},
            } as any,
            {
                chartType: 'groupedBar',
                xKey: 'period',
                yKey: 'amount_sum',
                useDualAxis: false,
                reason: 'period comparison',
                growth: { diff: 10_000, pct: 20, label: 'Current vs Previous' },
            } as any,
            {
                intent: 'total_comparison',
                dimensions: [],
                metrics: [{ field: 'amount', agg: 'sum' }],
                filters: [],
                comparison: { type: 'previous_period', mode: 'total', grain: 'month' },
                sort: [],
                limit: null,
                ambiguous: false,
                resultGrain: 'two period totals (current and previous)',
                originalQuestion: 'show this month and last month sales comparison',
            } as any,
        );

        expect(result.data).toHaveLength(2);
        expect(result.data.map(row => row.period)).toEqual(['This Month', 'Last Month']);
        expect(result.data.some(row => 'order_id' in row)).toBe(false);
        expect(result.chart.growth?.label).toBe('This Month vs Last Month');
    });
});
