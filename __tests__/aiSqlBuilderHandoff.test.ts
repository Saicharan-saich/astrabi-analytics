import { describe, expect, it } from 'vitest';
import { createAISQLBuilderHandoff } from '../services/ai-sql/builderHandoff';
import type { Dataset } from '../types';
import type { AISQLPipelineResult, SemanticModel } from '../services/ai-sql/types';

const semanticModel: SemanticModel = {
    datasetName: 'sales', rowCount: 2, grain: 'one row per order',
    compositeMetrics: [], derivedMetrics: [],
    timeContext: { anchorDate: '2025-03-15', minDate: '2025-02-01', maxDate: '2025-03-15', primaryDateColumn: 'order_date' },
    fields: [
        { name: 'order_date', physicalType: 'date', semanticType: 'date', role: 'dimension', defaultAgg: 'none', timeGrainSupport: ['day', 'month'], synonyms: [], valueDescriptors: [], distinctCount: 2, hasNulls: false, displayLabel: 'Order Date' },
        { name: 'category', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 2, hasNulls: false, displayLabel: 'Category' },
        { name: 'state', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 2, hasNulls: false, displayLabel: 'State' },
        { name: 'amount', physicalType: 'number', semanticType: 'currency', role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 2, hasNulls: false, displayLabel: 'Sales Amount' },
        { name: 'profit', physicalType: 'number', semanticType: 'currency', role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [], distinctCount: 2, hasNulls: false, displayLabel: 'Profit' },
    ],
};

const dataset: Dataset = {
    id: 'sales', name: 'sales.csv', totalRows: 2, etlLogs: [],
    rows: [
        { order_date: '2025-03-01', category: 'Furniture', state: 'CA', amount: 100, profit: 10 },
        { order_date: '2025-03-02', category: 'Technology', state: 'NY', amount: 200, profit: 30 },
    ],
    columns: [
        { name: 'order_date', type: 'DATE' as any, originalType: 'DATE' },
        { name: 'category', type: 'DIMENSION' as any, originalType: 'VARCHAR' },
        { name: 'state', type: 'DIMENSION' as any, originalType: 'VARCHAR' },
        { name: 'amount', type: 'METRIC' as any, originalType: 'DOUBLE' },
        { name: 'profit', type: 'METRIC' as any, originalType: 'DOUBLE' },
    ],
    aiSqlSemanticModel: semanticModel,
};

const formatting: any = {
    colorMode: 'vibrant', numberFormat: 'currency_usd', fontSize: 'md', headerSize: 'md',
    headerBold: true, showLabels: true, showDataLabels: true, tableCalculations: [],
};

function pipeline(overrides: Partial<AISQLPipelineResult> = {}): AISQLPipelineResult {
    return {
        plan: {
            intent: 'breakdown', dimensions: [{ field: 'category' }],
            metrics: [{ field: 'amount', agg: 'sum' }, { field: 'profit', agg: 'sum' }],
            filters: [{ field: 'state', op: '=', value: 'CA' }], sort: [{ field: 'amount', dir: 'desc' }],
            limit: 10, ambiguous: false, resultGrain: 'one row per category', originalQuestion: 'Sales and profit by category in CA',
        },
        sql: '', validation: { valid: true, checks: [] } as any, rawData: [], chartData: [],
        profile: {} as any,
        chart: { chartType: 'bar', xKey: 'category', yKey: 'amount', secondaryYKeys: ['profit'], useDualAxis: true, reason: 'breakdown' },
        confidence: {} as any, explanation: '', columnsUsed: [], executionTimeMs: 1, repairAttempts: 0,
        ...overrides,
    };
}

describe('AI SQL to Question Builder handoff', () => {
    it('transfers editable measures, dimensions, filters, sorting and limits', () => {
        const handoff = createAISQLBuilderHandoff(dataset, pipeline(), 'Sales and profit by category in CA', formatting);
        expect(handoff?.config).toMatchObject({
            metric: 'amount', aggregation: 'SUM', dimension: 'category',
            filters: { state: ['CA'] }, limit: 10, sort: 'desc',
            secondaryMetrics: ['profit'], secondaryMetricAggregations: { profit: 'SUM' },
            _source: 'ai-sql',
        });
        expect(handoff?.fidelity).toBe('full');
    });

    it('transfers period comparison and compatible table calculations', () => {
        const result = pipeline({
            plan: {
                ...pipeline().plan,
                intent: 'trend_comparison', dimensions: [{ field: 'order_date', timeGrain: 'month' }],
                metrics: [{ field: 'amount', agg: 'sum' }], filters: [],
                comparison: { type: 'previous_period', mode: 'trend', grain: 'month', offset: 1 },
            },
            querySpec: {
                goal: 'Monthly sales comparison', operations: {
                    tableCalculations: [{ type: 'percent_of_total' }, { type: 'rank', orderBy: ['amount DESC'] }],
                },
                expectedResult: { grain: 'month', columns: ['month', 'sales'] }, assumptions: [],
            },
        });
        const handoff = createAISQLBuilderHandoff(dataset, result, 'Compare monthly sales', formatting);
        expect(handoff?.config).toMatchObject({
            metric: 'amount', dimension: 'month', comparison: 'previous_period',
            comparisonMode: 'trend', comparisonGrain: 'month', comparisonOffset: 1,
        });
        expect(handoff?.formatting.tableCalculations).toEqual(['percent_of_total', 'rank_desc']);
    });

    it('opens dimension-only AI SQL lists as editable count distributions with a numeric chart measure', () => {
        const result = pipeline({
            plan: {
                intent: 'projection', dimensions: [{ field: 'category' }], metrics: [], filters: [], sort: [],
                projectionFields: ['category'], limit: null, ambiguous: false,
                resultGrain: 'one row per category', originalQuestion: 'Which categories are present?',
            },
        });
        const handoff = createAISQLBuilderHandoff(dataset, result, 'Which categories are present?', formatting);
        expect(handoff?.config).toMatchObject({
            metric: 'category', aggregation: 'COUNT', dimension: 'category', sort: 'desc',
        });
        expect(handoff?.warnings.join(' ')).toContain('row-count distribution');
    });
});
