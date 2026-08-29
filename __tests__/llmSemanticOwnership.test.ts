import { describe, expect, it } from 'vitest';
import { applyQuerySpecToAnalysisPlan, type DynamicQuerySpec } from '../services/ai-sql/directSqlEngine';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const model: SemanticModel = {
    datasetName: 'sales',
    rowCount: 100,
    grain: 'one row per order',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        {
            name: 'order_id', physicalType: 'string', semanticType: 'identifier', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 100,
            hasNulls: false, displayLabel: 'Order ID',
        },
        {
            name: 'category', physicalType: 'string', semanticType: 'category', role: 'dimension',
            defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 4,
            hasNulls: false, displayLabel: 'Category',
        },
        {
            name: 'amount', physicalType: 'number', semanticType: 'currency', role: 'metric',
            defaultAgg: 'sum', timeGrainSupport: [], synonyms: ['sales'], valueDescriptors: [], distinctCount: 90,
            hasNulls: false, displayLabel: 'Sales Amount',
        },
        {
            name: 'profit', physicalType: 'number', semanticType: 'currency', role: 'metric',
            defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 80,
            hasNulls: false, displayLabel: 'Profit',
        },
    ],
};

const wrongLocalPlan: AnalysisPlan = {
    intent: 'ranking',
    dimensions: [{ field: 'order_id' }],
    metrics: [{ field: 'amount', agg: 'count' }],
    filters: [],
    sort: [{ field: 'order_id', dir: 'desc' }],
    limit: 1,
    ambiguous: false,
    resultGrain: 'one row per order_id',
    originalQuestion: 'Show each category sales, percentage, rank and cumulative percentage.',
};

describe('LLM semantic ownership', () => {
    it('replaces a conflicting local grain with the model-authored Query Specification', () => {
        const spec: DynamicQuerySpec = {
            goal: 'Return one row per category with sales and derived calculations',
            operations: {
                groupBy: [{ field: 'category' }],
                measures: [
                    { field: 'amount', aggregation: 'sum' },
                    { field: 'profit', aggregation: 'sum' },
                ],
                tableCalculations: [
                    { type: 'rank', outputAlias: 'sales_rank', required: true },
                    { type: 'cumulative_percent', outputAlias: 'cumulative_sales_percentage', required: true },
                ],
            },
            expectedResult: {
                grain: 'one row per category',
                columns: ['category', 'total_sales', 'sales_rank', 'cumulative_sales_percentage'],
            },
            assumptions: [],
        };

        const adopted = applyQuerySpecToAnalysisPlan(wrongLocalPlan, spec, model);

        expect(adopted.dimensions).toEqual([{ field: 'category' }]);
        expect(adopted.metrics).toEqual([
            { field: 'amount', agg: 'sum' },
            { field: 'profit', agg: 'sum' },
        ]);
        expect(adopted.limit).toBeNull();
        expect(adopted.resultGrain).toBe('one row per category');
        expect(adopted.dimensions).not.toContainEqual({ field: 'order_id' });
    });

    it('does not translate arbitrary model expressions into local rewrite rules', () => {
        const spec: DynamicQuerySpec = {
            goal: 'Compare two independently ranked city sets',
            operations: {
                rankedSets: {
                    operation: 'difference',
                    entity: 'city',
                    branches: [
                        { metric: 'amount', aggregation: 'sum', direction: 'desc', limit: 10 },
                        { metric: 'profit', aggregation: 'sum', direction: 'desc', limit: 10 },
                    ],
                },
                groupBy: [{ field: 'city_not_in_single_table_model' }],
            },
            expectedResult: { grain: 'one row per qualifying city', columns: ['city'] },
            assumptions: [],
        };

        const adopted = applyQuerySpecToAnalysisPlan(wrongLocalPlan, spec, model);

        expect(adopted.dimensions).toEqual([]);
        expect(adopted.filters).toEqual([]);
        expect(adopted.sort).toEqual([]);
        expect(adopted.limit).toBeNull();
    });
});
