import { describe, expect, it } from 'vitest';
import { applyResolvedAmbiguitiesToPlan, resolveAmbiguities } from './ambiguityResolver';
import type { AmbiguityDetectionResult } from './ambiguityDetector';
import type { DatasetStatistics } from './localStatisticsResolver';
import type { AnalysisPlan, SemanticField, SemanticModel } from './types';

const metric = (
    name: string,
    displayLabel: string,
    synonyms: string[],
): SemanticField => ({
    name,
    displayLabel,
    physicalType: 'number',
    semanticType: 'currency',
    role: 'metric',
    defaultAgg: 'sum',
    timeGrainSupport: [],
    synonyms,
    valueDescriptors: [],
    distinctCount: 100,
    hasNulls: false,
});

const model: SemanticModel = {
    datasetName: 'Orders',
    rowCount: 100,
    grain: 'one row per order line',
    compositeMetrics: [],
    derivedMetrics: [],
    fields: [
        metric('sales', 'Sales', ['revenue']),
        metric('profit', 'Profit', ['margin']),
        {
            name: 'product_name',
            displayLabel: 'Product',
            physicalType: 'string',
            semanticType: 'category',
            role: 'dimension',
            defaultAgg: 'none',
            timeGrainSupport: [],
            synonyms: ['product'],
            valueDescriptors: [],
            distinctCount: 20,
            hasNulls: false,
        },
    ],
};

const stats: DatasetStatistics = {
    totalRows: 100,
    computedAt: Date.now(),
    timeStats: null,
    dimensions: {},
    metrics: {
        sales: {
            column: 'sales', mean: 100, median: 80, stddev: 30,
            p25: 50, p75: 130, p90: 180, p99: 300, min: 0, max: 400,
            nullRate: 0, nonNullCount: 100, stability: 0.3,
            distribution: 'skewed_right',
        },
        profit: {
            column: 'profit', mean: 10, median: 8, stddev: 15,
            p25: -2, p75: 20, p90: 35, p99: 60, min: -40, max: 80,
            nullRate: 0, nonNullCount: 100, stability: 1.5,
            distribution: 'normal',
        },
    },
};

const plan: AnalysisPlan = {
    intent: 'aggregate_filter',
    dimensions: [{ field: 'product_name' }],
    metrics: [
        { field: 'sales', agg: 'sum' },
        { field: 'profit', agg: 'sum' },
    ],
    filters: [],
    sort: [{ field: 'sales', dir: 'desc' }],
    limit: null,
    ambiguous: true,
    resultGrain: 'one row per product',
    originalQuestion: 'Which products have high sales but low or negative profit?',
};

const detection: AmbiguityDetectionResult = {
    hasHighMateriality: false,
    autoResolvableCount: 2,
    totalCount: 2,
    ambiguities: [
        {
            id: 'high-sales',
            type: 'threshold',
            phrase: 'high',
            candidates: [{ id: 'above_avg', label: 'Above average', description: '', confidence: 0.9 }],
            selected: { id: 'above_avg', label: 'Above average', description: '', confidence: 0.9 },
            confidence: 0.9,
            materiality: 'medium',
            resolvedBy: 'semantic_policy',
        },
        {
            id: 'low-profit',
            type: 'threshold',
            phrase: 'low or negative',
            candidates: [{ id: 'below_avg', label: 'Below average', description: '', confidence: 0.9 }],
            selected: { id: 'below_avg', label: 'Below average', description: '', confidence: 0.9 },
            confidence: 0.9,
            materiality: 'medium',
            resolvedBy: 'semantic_policy',
        },
    ],
};

describe('authoritative ambiguity resolution', () => {
    it('binds each threshold to the metric it qualifies', async () => {
        const resolution = await resolveAmbiguities(
            detection,
            model,
            stats,
            undefined,
            plan.originalQuestion,
            plan,
        );

        expect(resolution.resolved[0].resolution.field).toBe('sales');
        expect(resolution.resolved[0].computedThreshold).toBe(100);
        expect(resolution.resolved[1].resolution.field).toBe('profit');
        expect(resolution.resolved[1].computedThreshold).toBe(10);
    });

    it('applies evidence-backed thresholds before SQL generation', async () => {
        const resolution = await resolveAmbiguities(
            detection,
            model,
            stats,
            undefined,
            plan.originalQuestion,
            plan,
        );
        const executable = applyResolvedAmbiguitiesToPlan(plan, resolution);

        expect(executable.ambiguous).toBe(false);
        expect(executable.filters).toEqual(expect.arrayContaining([
            expect.objectContaining({ field: 'sales', op: '>', value: 100, isHaving: true }),
            expect.objectContaining({ field: 'profit', op: '<', value: 10, isHaving: true, includeNonPositive: true }),
        ]));
    });
});
