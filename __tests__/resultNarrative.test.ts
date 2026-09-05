import { describe, expect, it } from 'vitest';
import { buildResultNarrative } from '../services/ai-sql/resultNarrative';
import type { AnalysisPlan, ChartRecommendation, ResultProfile, SemanticModel } from '../services/ai-sql/types';

const model: SemanticModel = {
    datasetName: 'clinic', rowCount: 4, grain: 'one row per admission',
    compositeMetrics: [], derivedMetrics: [],
    timeContext: { anchorDate: '2024-05-07', minDate: '2024-05-06', maxDate: '2024-05-07', primaryDateColumn: 'date_of_admission' },
    fields: [
        { name: 'date_of_admission', physicalType: 'date', semanticType: 'date', role: 'dimension', defaultAgg: 'none', timeGrainSupport: ['day'], synonyms: [], valueDescriptors: [], distinctCount: 2, hasNulls: false, displayLabel: 'Date of Admission' },
    ],
};

const plan = (over: Partial<AnalysisPlan> = {}): AnalysisPlan => ({
    intent: 'single_metric', dimensions: [], metrics: [{ field: '*', agg: 'count' }],
    filters: [{ field: 'date_of_admission', op: 'between', value: ['2024-05-07', '2024-05-07'] }],
    sort: [], limit: null, ambiguous: false, resultGrain: 'scalar', originalQuestion: 'How busy are we today?', ...over,
});

const profile = (over: Partial<ResultProfile> = {}): ResultProfile => ({
    rowCount: 1, columnCount: 1, metricCount: 1, dimensionCount: 0,
    dimensionColumns: [], metricColumns: ['admissions_today'], dimensionCardinality: {},
    hasTimeDimension: false, metricsScaleMismatch: 1, metricSemanticTypes: { admissions_today: 'count' },
    isPivoted: false, isSingleValue: true, ...over,
});

const chart: ChartRecommendation = { chartType: 'kpiCard', xKey: 'admissions_today', yKey: 'admissions_today', useDualAxis: false, reason: 'scalar' };

describe('automatic result narratives', () => {
    it('adds a local previous-day comparison to a single-day count without changing its date anchor', () => {
        const narrative = buildResultNarrative({
            question: 'How busy are we today?', data: [{ admissions_today: 2 }], profile: profile(), chart,
            plan: plan(), model,
            sourceRows: [
                { date_of_admission: '2024-05-07' }, { date_of_admission: '2024-05-07' },
                { date_of_admission: '2024-05-06' },
            ],
        });
        expect(narrative?.summary).toContain('2 admissions today');
        expect(narrative?.summary).toContain('100% higher than the previous day (1)');
        expect(narrative?.verifiedFrom).toBe('executed_result_and_local_context');
        expect(model.timeContext?.anchorDate).toBe('2024-05-07');
    });

    it('summarizes rankings from returned values', () => {
        const rankingProfile = profile({
            rowCount: 2, columnCount: 2, dimensionCount: 1, metricCount: 1,
            dimensionColumns: ['doctor'], metricColumns: ['patient_count'],
            dimensionCardinality: { doctor: 2 }, isSingleValue: false,
        });
        const narrative = buildResultNarrative({
            question: 'Which doctors treated the most patients?',
            data: [{ doctor: 'Dr Lee', patient_count: 12 }, { doctor: 'Dr Shah', patient_count: 9 }],
            profile: rankingProfile, chart: { ...chart, chartType: 'bar', xKey: 'doctor', yKey: 'patient_count' },
            plan: plan({ intent: 'ranking', dimensions: [{ field: 'doctor' }], filters: [] }), model,
        });
        expect(narrative?.kind).toBe('ranking');
        expect(narrative?.summary).toContain('Dr Lee leads with 12');
        expect(narrative?.summary).toContain('Dr Shah with 9');
    });

    it('summarizes a returned dimension list without inventing a chart metric', () => {
        const listProfile = profile({
            rowCount: 3, columnCount: 1, dimensionCount: 1, metricCount: 0,
            dimensionColumns: ['doctor'], metricColumns: [], dimensionCardinality: { doctor: 3 },
            metricSemanticTypes: {}, isSingleValue: false,
        });
        const narrative = buildResultNarrative({
            question: 'Which doctors are on duty?',
            data: [{ doctor: 'Dr Lee' }, { doctor: 'Dr Shah' }, { doctor: 'Dr Jones' }],
            profile: listProfile, chart: { ...chart, chartType: 'table', xKey: 'doctor', yKey: '' },
            plan: plan({ intent: 'projection', dimensions: [{ field: 'doctor' }], metrics: [], filters: [] }), model,
        });
        expect(narrative?.kind).toBe('list');
        expect(narrative?.summary).toContain('3 matching results');
    });
});
