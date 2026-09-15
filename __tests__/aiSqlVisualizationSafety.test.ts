import { describe, expect, it } from 'vitest';
import { profileResult } from '../services/ai-sql/resultProfiler';
import { recommendChart } from '../services/ai-sql/chartRecommender';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const field = (name: string, role: 'metric' | 'dimension', semanticType: any = role === 'metric' ? 'quantity' : 'category'): any => ({
    name, displayLabel: name.replace(/_/g, ' '), physicalType: role === 'metric' ? 'number' : 'string',
    semanticType, role, defaultAgg: role === 'metric' ? 'sum' : 'none', timeGrainSupport: [],
    synonyms: [], valueDescriptors: [], distinctCount: 4, hasNulls: false,
});

const model: SemanticModel = {
    datasetName: 'data', rowCount: 9, grain: 'one row per trade summary', compositeMetrics: [], derivedMetrics: [],
    fields: [
        field('summary_id', 'dimension', 'identifier'),
        field('period_label', 'dimension'),
        field('period_id', 'dimension', 'identifier'),
        field('geo_name', 'dimension'),
        field('reporter_geo_id', 'dimension', 'identifier'),
        field('trade_scope', 'dimension'),
        field('flow_direction', 'dimension'),
        field('value_usd_bn', 'metric', 'currency'),
        field('data_status', 'dimension'),
        field('source_name', 'dimension'),
    ],
};

function plan(overrides: Partial<AnalysisPlan> = {}): AnalysisPlan {
    return {
        intent: 'projection', dimensions: [], metrics: [], filters: [], sort: [], limit: null,
        projectionFields: [], ambiguous: false, resultGrain: 'one row per trade summary', originalQuestion: '',
        ...overrides,
    };
}

describe('AI SQL visualization safety', () => {
    it('opens a wide row-level projection as a table instead of a heatmap', () => {
        const rows = [{
            summary_id: 'S1', period_label: 'FY2024-25', period_id: 'P1', geo_name: 'India', reporter_geo_id: 'IN',
            trade_scope: 'Merchandise', flow_direction: 'Export', value_usd_bn: 437.4, data_status: 'Final', source_name: 'Ministry',
        }];
        const governedPlan = plan({ projectionFields: Object.keys(rows[0]) });
        const profile = profileResult(rows, governedPlan, model);
        expect(recommendChart(profile, governedPlan, model)).toMatchObject({ chartType: 'table' });
    });

    it('uses both grouped dimensions in a stacked bar rather than silently switching to a heatmap', () => {
        const rows = [
            { trade_scope: 'Merchandise', flow_direction: 'Export', value_usd_bn_sum: 437.4 },
            { trade_scope: 'Merchandise', flow_direction: 'Import', value_usd_bn_sum: 720.2 },
            { trade_scope: 'Services', flow_direction: 'Export', value_usd_bn_sum: 341.1 },
        ];
        const governedPlan = plan({
            intent: 'breakdown', projectionFields: undefined,
            dimensions: [{ field: 'trade_scope' }, { field: 'flow_direction' }],
            metrics: [{ field: 'value_usd_bn', agg: 'sum' }],
            resultGrain: 'one row per trade scope and flow direction',
        });
        const profile = profileResult(rows, governedPlan, model);
        expect(recommendChart(profile, governedPlan, model)).toMatchObject({
            chartType: 'stackedBar', xKey: 'trade_scope', yKey: 'value_usd_bn_sum',
        });
    });
});
