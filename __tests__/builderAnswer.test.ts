import { describe, expect, it } from 'vitest';
import { AggregationType, AnalysisType, TimeGrain, type AnalysisResult } from '../types';
import { describeBuilderFinding, describeBuilderQuestion } from '../utils/builderAnswer';

describe('Question Builder answer in words', () => {
    it('describes ranking only when sorting and a limit actually request it', () => {
        expect(describeBuilderQuestion({ metric: 'sales_amount', aggregation: 'SUM', dimension: 'product', sort: 'desc', limit: 5 }))
            .toBe('You are viewing top 5 products by total sales amount.');
        expect(describeBuilderQuestion({ metric: 'profit', aggregation: 'SUM', dimension: 'city', sort: 'asc', limit: 5 }))
            .toBe('You are viewing bottom 5 cities by total profit.');
    });

    it('does not claim a month-over-month comparison from a monthly grouping alone', () => {
        expect(describeBuilderQuestion({ metric: 'sales', aggregation: 'SUM', dimension: 'month' }))
            .toBe('You are viewing total sales by month.');
        expect(describeBuilderQuestion({ metric: 'sales', aggregation: 'SUM', dimension: 'month', comparison: 'previous_period' }))
            .toBe('You are viewing total sales by month, compared with the previous period.');
    });

    it('includes applied additional measures, filters and period without inventing an as-of date', () => {
        expect(describeBuilderQuestion({
            metric: 'sales', aggregation: 'SUM', dimension: 'region',
            secondaryMetrics: ['profit'], secondaryMetricAggregations: { profit: 'AVG' },
            filters: { country: ['UK'] }, timeFilter: 'this_month',
        })).toBe('You are viewing total sales by region, alongside average profit for this month, filtered to country: UK.');
    });

    it('reports a scalar value only from the executed result', () => {
        const result = {
            data: [{ value: 243900 }], xKey: '', yKey: 'value', yLabel: 'Total profit',
            insight: '', sql: '', config: {
                metric: 'profit', dimension: '', aggregation: AggregationType.SUM,
                timeGrain: TimeGrain.RAW, analysisType: AnalysisType.STANDARD,
            },
        } as AnalysisResult;
        expect(describeBuilderFinding(result)).toBe('Total profit is 243,900.');
        expect(describeBuilderFinding({ ...result, data: [] })).toBe('No matching data was found for this question.');
        expect(describeBuilderFinding({ ...result, data: [{ value: 1 }, { value: 2 }] })).toBeNull();
    });
});
