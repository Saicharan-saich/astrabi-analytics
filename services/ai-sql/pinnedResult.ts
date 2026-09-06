import type { AnalysisResult, ChartConfig, Dataset, FormattingConfig } from '../../types';
import { executeSQLViaDuckDB } from '../duckdbEngine';
import { reshapeData } from './dataReshaper';
import { profileResult } from './resultProfiler';
import { resolveAISQLSemanticModel } from './semanticLayer';
import type { AISQLPipelineResult, AnalysisIntent, AnalysisPlan, ChartRecommendation, SemanticModel } from './types';

const CHART_TYPE_MAP: Record<string, ChartConfig['type']> = {
    kpiCard: 'kpiCard',
    kpi: 'kpiCard',
    line: 'line',
    multiLine: 'line',
    bar: 'bar',
    horizontalBar: 'horizontalBar',
    groupedBar: 'groupedBar',
    stackedBar: 'stackedBar',
    area: 'area',
    dualAxisCombo: 'combo',
    combo: 'combo',
    donut: 'doughnut',
    doughnut: 'doughnut',
    heatmap: 'bar',
    table: 'table',
};

function presentationChartType(value: string | undefined, fallback: ChartConfig['type']): ChartConfig['type'] {
    return (value && CHART_TYPE_MAP[value]) || fallback;
}

function copyFormatting(formatting: FormattingConfig): FormattingConfig {
    return {
        ...formatting,
        tableCalculations: [...(formatting.tableCalculations || [])],
        tableCalculationComparison: formatting.tableCalculationComparison
            ? { ...formatting.tableCalculationComparison }
            : undefined,
    };
}

function recommendationChartType(value: ChartConfig['type'] | undefined): ChartRecommendation['chartType'] {
    switch (value) {
        case 'kpiCard': case 'kpi': return 'kpiCard';
        case 'line': case 'curvedLine': case 'steppedLine': return 'line';
        case 'horizontalBar': return 'horizontalBar';
        case 'groupedBar': return 'groupedBar';
        case 'stackedBar': return 'stackedBar';
        case 'area': case 'stackedArea': return 'area';
        case 'combo': return 'dualAxisCombo';
        case 'pie': case 'doughnut': case 'polarArea': return 'donut';
        case 'table': return 'table';
        default: return 'bar';
    }
}

/**
 * Older pinned AI SQL cards saved only queryConfig.aiSql. Upgrade them in
 * memory on first refresh so existing dashboards benefit from the corrected
 * refresh path without requiring a re-pin.
 */
export function ensurePinnedAISQLRefreshContext(previous: AnalysisResult): AnalysisResult {
    if (previous.aiSqlRefresh) return previous;
    const sql = previous.queryConfig?.aiSql;
    if (typeof sql !== 'string' || !sql.trim()) return previous;

    const question = previous.config.questionLabel || previous.yLabel || 'AI SQL analysis';
    const normalizedQuestion = question.toLowerCase();
    const intent: AnalysisIntent = previous.vis === 'doughnut' || previous.vis === 'pie'
        ? 'share_of_total'
        : /\b(compare|comparison|versus|vs|previous|last month|last year)\b/.test(normalizedQuestion)
            ? 'total_comparison'
            : previous.config.limit
                ? 'ranking'
                : 'breakdown';
    const dimension = previous.config.dimension;
    const metricNames = [previous.config.metric, ...(previous.config.secondaryMetrics || [])]
        .filter((field): field is string => Boolean(field));
    const plan: AnalysisPlan = {
        intent,
        dimensions: dimension && !/^metric$/i.test(previous.xKey) ? [{ field: dimension }] : [],
        metrics: metricNames.map(field => ({ field, agg: 'sum' as const })),
        filters: [],
        comparison: intent === 'total_comparison'
            ? { type: 'previous_period', mode: 'total' }
            : undefined,
        sort: [],
        limit: previous.config.limit || null,
        ambiguous: false,
        resultGrain: previous.xKey ? `one row per ${previous.xKey}` : 'result row',
        originalQuestion: question,
    };
    const chart: ChartRecommendation = {
        chartType: recommendationChartType(previous.vis),
        xKey: previous.xKey,
        yKey: previous.yKey,
        secondaryYKeys: previous.secondaryYKeys || previous.config.secondaryMetrics,
        useDualAxis: previous.axisMode === 'dual' || previous.config.axisMode === 'dual',
        reason: 'Restored from a pinned AI SQL visual created before refresh metadata was introduced.',
    };

    return {
        ...previous,
        aiSqlRefresh: {
            version: 1,
            source: 'ai-sql',
            question,
            sql,
            plan,
            chart,
        },
    };
}

/**
 * Freeze the exact visual the user is looking at, together with a local-only
 * refresh recipe. This deliberately stores presentation state separately from
 * the SQL plan: changing labels or chart type must not change the query.
 */
export function createPinnedAISQLResult(args: {
    result: AnalysisResult;
    pipeline: AISQLPipelineResult;
    question: string;
    formatting: FormattingConfig;
    chartType?: string;
}): AnalysisResult {
    const { result, pipeline, question, formatting, chartType } = args;
    const sql = pipeline.sql || result.sql;
    const vis = presentationChartType(chartType, result.vis || 'bar');
    const secondaryYKeys = result.secondaryYKeys || pipeline.chart.secondaryYKeys;
    const axisMode = pipeline.chart.useDualAxis ? 'dual' : (result.axisMode || 'single');
    const queryConfig = {
        ...(result.queryConfig || result.config),
        aiSql: sql,
        questionLabel: question,
    };

    return {
        ...result,
        data: result.data.map(row => ({ ...row })),
        yLabel: question,
        sql,
        vis,
        formatting: copyFormatting(formatting),
        secondaryYKeys,
        axisMode,
        config: {
            ...result.config,
            chartType: vis as any,
            secondaryMetrics: secondaryYKeys,
            axisMode: pipeline.chart.useDualAxis ? 'dual' : (result.config.axisMode || 'single'),
            questionLabel: question,
        },
        queryConfig,
        aiSqlRefresh: {
            version: 1,
            source: 'ai-sql',
            question,
            sql,
            plan: pipeline.plan,
            chart: { ...pipeline.chart },
        },
    };
}

/**
 * Rebuild chart-ready data from a fresh execution of the stored SQL while
 * retaining the user's chart choice and all formatting controls.
 */
export function rebuildPinnedAISQLPresentation(
    previous: AnalysisResult,
    rawData: Record<string, any>[],
    semanticModel: SemanticModel,
): AnalysisResult {
    const refresh = previous.aiSqlRefresh;
    if (!refresh) return previous;

    const safeRows = rawData.map(row => ({ ...row }));
    const profile = profileResult(safeRows, refresh.plan, semanticModel);
    const reshaped = reshapeData(safeRows, profile, { ...refresh.chart }, refresh.plan);
    const secondaryYKeys = reshaped.chart.secondaryYKeys;
    const isKpi = reshaped.chart.chartType === 'kpiCard';

    return {
        ...previous,
        data: reshaped.data,
        xKey: reshaped.chart.xKey,
        yKey: reshaped.chart.yKey,
        kpi: isKpi && reshaped.data.length > 0
            ? reshaped.data[0]?.[reshaped.chart.yKey]
            : undefined,
        growth: reshaped.chart.growth
            ? { diff: reshaped.chart.growth.diff, pct: reshaped.chart.growth.pct }
            : undefined,
        secondaryYKeys,
        axisMode: reshaped.chart.useDualAxis ? 'dual' : (previous.axisMode || 'single'),
        config: {
            ...previous.config,
            secondaryMetrics: secondaryYKeys,
            axisMode: reshaped.chart.useDualAxis ? 'dual' : (previous.config.axisMode || 'single'),
        },
        // Preserve the selected visual and label/style state. Refresh changes
        // values, not how the user chose to present those values.
        vis: previous.vis,
        formatting: previous.formatting,
        queryConfig: previous.queryConfig,
        aiSqlRefresh: {
            ...refresh,
            chart: { ...reshaped.chart },
        },
    };
}

export async function refreshPinnedAISQLResult(
    dataset: Dataset,
    previous: AnalysisResult,
): Promise<AnalysisResult> {
    const upgradedPrevious = ensurePinnedAISQLRefreshContext(previous);
    const refresh = upgradedPrevious.aiSqlRefresh;
    if (!refresh) return previous;

    const semanticModel = resolveAISQLSemanticModel(dataset).model;
    const execution = await executeSQLViaDuckDB(
        dataset.rows,
        refresh.sql,
        semanticModel.timeContext,
        dataset.relatedTables,
    );
    if (execution.error) throw new Error(execution.error);

    return rebuildPinnedAISQLPresentation(upgradedPrevious, execution.data, semanticModel);
}
