import { describe, expect, it } from 'vitest';
import { recommendChart } from './chartRecommender';
import type { AnalysisPlan, ResultProfile, SemanticModel } from './types';

const model: SemanticModel = {
    datasetName: 'Orders', rowCount: 100, grain: 'one row per order',
    compositeMetrics: [], derivedMetrics: [],
    fields: [
        { name: 'customer_name', displayLabel: 'Customer name', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 20, hasNulls: false },
        { name: 'sales', displayLabel: 'Sales', physicalType: 'number', semanticType: 'currency', role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 80, hasNulls: false },
    ],
};
const plan: AnalysisPlan = {
    intent: 'breakdown', dimensions: [{ field: 'customer_name' }],
    metrics: [{ field: 'sales', agg: 'sum' }], filters: [], sort: [], limit: null,
    ambiguous: false, resultGrain: 'one row per customer', originalQuestion: 'Which customers bought from every category?',
};
const profile: ResultProfile = {
    rowCount: 16, columnCount: 2, metricCount: 1, dimensionCount: 1,
    dimensionColumns: ['customer_name'], metricColumns: ['categories_bought'],
    dimensionCardinality: { customer_name: 16 }, hasTimeDimension: false,
    metricsScaleMismatch: 1, metricSemanticTypes: { categories_bought: 'count' },
    isPivoted: false, isSingleValue: false,
};

describe('Answer Table recommendation', () => {
    it('uses a labelled table for named answer lists', () => {
        const recommendation = recommendChart(profile, plan, model);
        expect(recommendation.chartType).toBe('table');
        expect(recommendation.reason).toContain('Answer Table');
    });

    it('keeps charts available for intentional rankings', () => {
        const ranked = recommendChart(profile, { ...plan, intent: 'ranking' }, model);
        expect(ranked.chartType).not.toBe('table');
    });
});
