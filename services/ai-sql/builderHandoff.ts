import type { Dataset, FormattingConfig, QueryConfig } from '../../types';
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

    const physicalFields = new Set(dataset.columns.map(column => column.name.toLowerCase()));
    const editableDimensions = new Set(model.fields
        .filter(field => field.role === 'dimension' && field.physicalType !== 'date')
        .map(field => field.name.toLowerCase()));
    const editableMeasureFilters = new Set(model.fields
        .filter(field => field.physicalType === 'number')
        .map(field => field.name.toLowerCase()));
    const physicalMetric = physicalFields.has(String(source.metric || '').toLowerCase()) ? source.metric : fallback?.metric;
    const editableDimension = editableDimensions.has(String(source.dimension || '').toLowerCase()) ? source.dimension : '';
    const editableFilters = Object.fromEntries(Object.entries(source.filters || {})
        .filter(([field]) => editableDimensions.has(field.toLowerCase())));
    const editableMeasures = (source.measureFilters || [])
        .filter((filter: { column?: string }) => editableMeasureFilters.has(String(filter.column || '').toLowerCase()));

    if (source.dimension && !editableDimension) {
        warnings.push(`The “${source.dimension}” grouping uses a time or generated field, so the GAFS edit starts without that hidden grouping.`);
    }
    if (Object.keys(editableFilters).length !== Object.keys(source.filters || {}).length
        || editableMeasures.length !== (source.measureFilters || []).length) {
        warnings.push('Filters that require time or non-GAFS controls remain in the original AI SQL result and are not active in this edit.');
    }

    // AI SQL opens a deliberately narrow editing surface: Group, Aggregate,
    // Filter and Sort (plus Top/Bottom limit). Hidden analytical operations
    // must also be absent from the executable config so they cannot silently
    // influence an edited result.
    const config: Record<string, any> = {
        metric: physicalMetric,
        aggregation: source.aggregation || AGGREGATIONS[pipeline.plan.metrics[0]?.agg || 'sum'] || 'SUM',
        dimension: editableDimension,
        timeFilter: 'all_time',
        filters: editableFilters,
        measureFilters: editableMeasures,
        dateFilters: [],
        sort: source.sort || pipeline.plan.sort[0]?.dir || 'desc',
        limit: source.limit || pipeline.plan.limit || 0,
        secondaryMetrics: [],
        secondaryMetricAggregations: {},
        secondaryDimensions: [],
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

    const hasNonGafsOperations = Boolean(
        pipeline.plan.comparison
        || source.timeFilter && source.timeFilter !== 'all_time'
        || source.dateFilters?.length
        || source.secondaryMetrics?.length
        || source.secondaryDimensions?.length
        || pipeline.querySpec?.operations?.tableCalculations?.length
        || formatting.tableCalculations?.some(calculation => calculation !== 'none')
    );
    if (hasNonGafsOperations) {
        warnings.push('This edit view intentionally exposes only grouping, aggregation, filtering, sorting and limit controls. Time intelligence, comparisons, table calculations and additional series remain available in the original AI SQL result but are not active here.');
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
        formatting: { ...formatting, tableCalculations: [] },
        fidelity: uniqueWarnings.length ? 'partial' : 'full',
        warnings: uniqueWarnings,
    };
}
