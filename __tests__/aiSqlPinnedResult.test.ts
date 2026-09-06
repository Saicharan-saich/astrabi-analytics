import { describe, expect, it } from 'vitest';
import { createPinnedAISQLResult, ensurePinnedAISQLRefreshContext, rebuildPinnedAISQLPresentation } from '../services/ai-sql/pinnedResult';
import type { AnalysisResult, FormattingConfig } from '../types';
import type { AISQLPipelineResult, AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const plan: AnalysisPlan = {
    intent: 'total_comparison',
    dimensions: [],
    metrics: [{ field: 'admissions', agg: 'count' }],
    filters: [],
    sort: [],
    limit: null,
    ambiguous: false,
    resultGrain: 'one summary row',
    originalQuestion: 'Compare this month and last month admissions',
};

const formatting: FormattingConfig = {
    colorMode: 'vibrant',
    numberFormat: 'compact',
    fontSize: 'md',
    headerSize: 'lg',
    headerBold: true,
    showLabels: true,
    showDataLabels: true,
    dataLabelMode: 'all',
    tableCalculations: [],
};

const baseResult: AnalysisResult = {
    data: [
        { Metric: 'This Month Admissions', Value: 212 },
        { Metric: 'Last Month Admissions', Value: 941 },
        { Metric: 'Admission Count Difference', Value: -729 },
        { Metric: 'Admission Percentage Change', Value: -77.47 },
    ],
    xKey: 'Metric',
    yKey: 'Value',
    yLabel: plan.originalQuestion,
    insight: 'Comparison',
    sql: 'SELECT 212 AS this_month_admissions',
    config: {
        metric: 'admissions',
        dimension: '',
        aggregation: 'COUNT' as any,
        timeGrain: 'Raw Date' as any,
        analysisType: 'Standard' as any,
        questionId: 'ai_sql_test',
    },
    vis: 'groupedBar',
};

const pipeline = {
    plan,
    sql: 'SELECT 212 AS this_month_admissions, 941 AS last_month_admissions, -729 AS admission_count_difference, -77.47 AS admission_percentage_change',
    chart: {
        chartType: 'groupedBar',
        xKey: 'Metric',
        yKey: 'Value',
        useDualAxis: false,
        reason: 'wide comparison',
    },
} as AISQLPipelineResult;

const semanticModel: SemanticModel = {
    fields: [],
    compositeMetrics: [],
    derivedMetrics: [],
    datasetName: 'Healthcare',
    rowCount: 100,
    grain: 'admission',
};

describe('AI SQL pinned visual lifecycle', () => {
    it('pins the visual currently shown with SQL refresh metadata and label settings', () => {
        const pinned = createPinnedAISQLResult({
            result: baseResult,
            pipeline,
            question: plan.originalQuestion,
            formatting,
            chartType: 'groupedBar',
        });

        expect(pinned.vis).toBe('groupedBar');
        expect(pinned.formatting?.showDataLabels).toBe(true);
        expect(pinned.formatting?.dataLabelMode).toBe('all');
        expect(pinned.queryConfig.aiSql).toBe(pipeline.sql);
        expect(pinned.aiSqlRefresh).toMatchObject({
            version: 1,
            source: 'ai-sql',
            question: plan.originalQuestion,
            sql: pipeline.sql,
        });

        pinned.formatting!.tableCalculations.push({} as any);
        expect(formatting.tableCalculations).toHaveLength(0);
    });

    it('rebuilds a refreshed wide SQL result into the same four-bar visual', () => {
        const pinned = createPinnedAISQLResult({
            result: baseResult,
            pipeline,
            question: plan.originalQuestion,
            formatting,
            chartType: 'groupedBar',
        });
        const refreshed = rebuildPinnedAISQLPresentation(pinned, [{
            this_month_admissions: 300,
            last_month_admissions: 600,
            admission_count_difference: -300,
            admission_percentage_change: -50,
        }], semanticModel);

        expect(refreshed.data).toHaveLength(4);
        expect(refreshed.xKey).toBe('Metric');
        expect(refreshed.yKey).toBe('Value');
        expect(refreshed.data.map(row => row.Value)).toEqual([300, 600, -300, -50]);
        expect(refreshed.vis).toBe('groupedBar');
        expect(refreshed.formatting?.dataLabelMode).toBe('all');
        expect(refreshed.queryConfig.aiSql).toBe(pipeline.sql);
    });

    it('upgrades previously pinned AI SQL cards without asking the user to re-pin', () => {
        const legacy = {
            ...baseResult,
            formatting,
            queryConfig: { ...baseResult.config, aiSql: pipeline.sql },
        };
        const upgraded = ensurePinnedAISQLRefreshContext(legacy);

        expect(upgraded.aiSqlRefresh?.source).toBe('ai-sql');
        expect(upgraded.aiSqlRefresh?.sql).toBe(pipeline.sql);
        expect(upgraded.aiSqlRefresh?.chart.chartType).toBe('groupedBar');
    });
});
