import type { Dataset, FormattingConfig, QueryConfig } from '../../types';
import type { TableCalculation } from '../../utils/tableCalculations';
import type { AISQLPipelineResult, AnalysisIntent, AnalysisPlan } from './types';
import { resolveAISQLSemanticModel } from './semanticLayer';
import { mapPlanToQBConfig } from './qbMapper';

export interface AISQLBuilderHandoff {
    config: QueryConfig & {
        _handoffId: string;
        _source: 'ai-sql';
        _sourceQuestion: string;
        _handoffWarnings: string[];
    };
    formatting: FormattingConfig;
    fidelity: 'full' | 'partial';
    warnings: string[];
}

const AGGREGATIONS: Record<string, string> = {
    sum: 'SUM', avg: 'AVG', count: 'COUNT', count_distinct: 'COUNT_DISTINCT',
    min: 'MIN', max: 'MAX', median: 'MEDIAN', none: 'NONE',
};

function builderIntent(plan: AnalysisPlan): AnalysisIntent {
    if (plan.intent === 'total_comparison') return 'single_metric';
    if (plan.intent === 'trend_comparison') return 'trend';
    if (plan.intent === 'growth_analysis') return plan.dimensions.length ? 'ranking' : 'single_metric';
    if (plan.intent === 'derived_metric') return plan.dimensions.length ? 'breakdown' : 'single_metric';
    return plan.intent;
}

function chartType(value: string | undefined): QueryConfig['chartType'] {
    const map: Record<string, QueryConfig['chartType']> = {
        kpiCard: 'kpi', dualAxisCombo: 'combo', multiLine: 'line', donut: 'doughnut',
        horizontalBar: 'bar', groupedBar: 'bar', stackedBar: 'bar', heatmap: 'table',
    };
    return map[value || ''] || value as QueryConfig['chartType'] || 'bar';
}

function mapTableCalculation(type: string, direction?: string): TableCalculation | null {
    const value = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
    if (/percent.*total|share.*total/.test(value) && !/cumulative/.test(value)) return 'percent_of_total';
    if (/running.*total/.test(value)) return 'running_total';
    if (/moving.*(?:avg|average)/.test(value)) return 'moving_avg';
    if (/percent.*(?:difference|change)|growth|pct_diff/.test(value)) return 'pct_diff_from_prev';
    if (/(?:difference|change).*previous|diff_from_prev/.test(value)) return 'diff_from_prev';
    if (/rank/.test(value)) return String(direction || '').toLowerCase() === 'asc' ? 'rank_asc' : 'rank_desc';
    if (/percentile/.test(value)) return 'percentile';
    if (/standard.*deviation|std_dev/.test(value)) return 'std_dev';
    if (/z_?score/.test(value)) return 'z_score';
    if (/variance/.test(value)) return 'variance';
    if (/forecast/.test(value)) return 'linear_forecast';
    return null;
}

function projectionFallback(plan: AnalysisPlan, dataset: Dataset): Record<string, any> | null {
    const field = plan.projectionFields?.[0] || plan.dimensions[0]?.field;
    if (!field || !dataset.columns.some(column => column.name.toLowerCase() === field.toLowerCase())) return null;
    const physical = dataset.columns.find(column => column.name.toLowerCase() === field.toLowerCase())!.name;

    // The visual builder needs a numeric Y value. Passing a dimension as both
    // metric and dimension with NONE aggregation produces a categorical value
    // on the Y axis (and Chart.js quite correctly renders an empty zero-scale
    // chart). A dimension-only AI SQL list therefore becomes an editable
    // frequency view: one bar per returned value and a local row count. This is
    // a faithful, useful base for slice-and-dice while the original AI SQL
    // result remains available on the result page.
    return {
        metric: physical,
        aggregation: 'COUNT',
        dimension: physical,
        sort: 'desc',
        limit: plan.limit || 0,
    };
}

/**
 * Convert the model-owned AI SQL plan into the editable subset of the visual
 * Question Builder. The bridge never reparses SQL and never guesses values:
 * it uses the plan/specification that produced the executed result.
 */
export function createAISQLBuilderHandoff(
    dataset: Dataset,
    pipeline: AISQLPipelineResult,
    question: string,
    formatting: FormattingConfig,
): AISQLBuilderHandoff | null {
    const model = resolveAISQLSemanticModel(dataset).model;
    const normalizedPlan: AnalysisPlan = {
        ...pipeline.plan,
        intent: builderIntent(pipeline.plan),
        comparison: undefined,
    };
    const mapped = mapPlanToQBConfig(normalizedPlan, model);
    const fallback = projectionFallback(pipeline.plan, dataset);
    const warnings: string[] = [];
    let source: Record<string, any>;
    if (mapped.fits) {
        source = mapped.config;
    } else {
        if (!fallback) return null;
        source = fallback;
        const noFitReason = 'reason' in mapped ? mapped.reason : 'the analytical shape has no direct builder control';
        warnings.push(`The base fields were transferred, but the builder cannot directly represent the complete AI SQL operation: ${noFitReason}`);
        if (pipeline.plan.metrics.length === 0) {
            warnings.push('This dimension-only result is shown as a row-count distribution so it has a valid editable visual; the original AI SQL list is unchanged.');
        }
    }

    // Only controls that the current Question Builder visibly exposes are
    // carried forward. Never hide an active predicate inside an editable view.
    const config: Record<string, any> = {
        metric: source.metric,
        aggregation: source.aggregation || AGGREGATIONS[pipeline.plan.metrics[0]?.agg || 'sum'] || 'SUM',
        dimension: source.dimension || '',
        timeFilter: source.timeFilter || 'all_time',
        filters: source.filters || {},
        measureFilters: source.measureFilters || [],
        dateFilters: source.dateFilters || [],
        sort: source.sort || pipeline.plan.sort[0]?.dir || 'desc',
        limit: source.limit || pipeline.plan.limit || 0,
        secondaryMetrics: source.secondaryMetrics || [],
        secondaryMetricAggregations: source.secondaryMetricAggregations || {},
        secondaryDimensions: source.secondaryDimensions || [],
        chartType: chartType(pipeline.chart.chartType),
        questionLabel: question,
        questionId: `ai_sql_handoff_${Date.now()}`,
    };

    const hiddenOperations = [
        ['exclusion filters', (source as any).excludeFilters],
        ['text-pattern filters', (source as any).likeFilters],
        ['row-level numeric filters', (source as any).numericFilters],
        ['numeric ranges', (source as any).numericRanges],
        ['aggregate-reference filters', (source as any).aggregateFilters],
        ['group-average conditions', (source as any).groupAvgHaving],
    ] as const;
    for (const [label, operation] of hiddenOperations) {
        if (operation && (Array.isArray(operation) ? operation.length : Object.keys(operation).length)) {
            warnings.push(`${label} remain visible in the original AI SQL result but are not editable builder controls yet.`);
        }
    }

    if (pipeline.plan.comparison) {
        config.comparison = pipeline.plan.comparison.type;
        config.comparisonMode = pipeline.plan.comparison.mode;
        config.comparisonGrain = pipeline.plan.comparison.grain;
        config.comparisonOffset = pipeline.plan.comparison.offset || 1;
    }

    const calculations: TableCalculation[] = [];
    for (const calculation of pipeline.querySpec?.operations?.tableCalculations || []) {
        const mappedCalculation = mapTableCalculation(calculation.type, calculation.orderBy?.[0]);
        if (mappedCalculation && !calculations.includes(mappedCalculation)) calculations.push(mappedCalculation);
        else if (!mappedCalculation) warnings.push(`The “${calculation.type}” calculation remains available in AI SQL but has no equivalent builder control.`);
    }
    if (pipeline.plan.intent === 'share_of_total' && !calculations.includes('percent_of_total')) {
        calculations.push('percent_of_total');
    }

    if (pipeline.querySpec?.operations?.joins?.length) {
        warnings.push('The AI SQL relationship path was executed across source tables; the builder uses the prepared dataset view. Verify the grain after changing fields.');
    }
    if (pipeline.querySpec?.operations?.ratio || pipeline.querySpec?.operations?.rankedSets) {
        warnings.push('A ratio or ranked-set operation cannot currently be reconstructed as editable builder controls. The transferable base analysis has been opened instead.');
    }

    const uniqueWarnings = [...new Set(warnings)];
    config._handoffId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    config._source = 'ai-sql';
    config._sourceQuestion = question;
    config._handoffWarnings = uniqueWarnings;

    return {
        config: config as AISQLBuilderHandoff['config'],
        formatting: { ...formatting, tableCalculations: calculations.length ? calculations : formatting.tableCalculations },
        fidelity: uniqueWarnings.length ? 'partial' : 'full',
        warnings: uniqueWarnings,
    };
}
