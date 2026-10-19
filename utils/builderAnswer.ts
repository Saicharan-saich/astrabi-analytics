import type { AnalysisResult, FormattingConfig } from '../types';

export interface BuilderQuestionDescription {
    metric?: string;
    aggregation?: string;
    dimension?: string;
    secondaryDimensions?: string[];
    secondaryMetrics?: string[];
    secondaryMetricAggregations?: Record<string, string>;
    timeFilter?: string;
    filters?: Record<string, string[]>;
    measureFilters?: Array<{ column: string; operator: string; value: number }>;
    dateFilters?: Array<{ column: string; timeGrain: string; values: string[] }>;
    sort?: string;
    limit?: number;
    comparison?: string;
    comparisonGrain?: string;
    comparisonOffset?: number;
}

const TIME_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year', 'hour', 'minute']);
const TIME_FILTERS: Record<string, string> = {
    today: 'today', yesterday: 'yesterday', this_week: 'this week',
    this_month: 'this month', this_quarter: 'this quarter', this_year: 'this year',
    last_7_days: 'the last 7 days', last_30_days: 'the last 30 days',
    last_90_days: 'the last 90 days',
};

const words = (value: string) => value.replace(/_/g, ' ').trim();
const measure = (metric: string, aggregation?: string) => {
    const label = words(metric);
    switch ((aggregation || 'SUM').toUpperCase()) {
        case 'AVG': return `average ${label}`;
        case 'COUNT': return `count of ${label}`;
        case 'COUNT_DISTINCT': return `number of unique ${label}`;
        case 'MIN': return `lowest ${label}`;
        case 'MAX': return `highest ${label}`;
        case 'NONE': return label;
        default: return `total ${label}`;
    }
};

const plural = (value: string) => {
    const label = words(value);
    if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
    if (/s$/i.test(label)) return label;
    return `${label}s`;
};

const describeFilters = (config: BuilderQuestionDescription): string[] => {
    const descriptions: string[] = [];
    for (const [column, values] of Object.entries(config.filters || {})) {
        if (values?.length) descriptions.push(`${words(column)}: ${values.slice(0, 2).join(' or ')}${values.length > 2 ? ` and ${values.length - 2} more` : ''}`);
    }
    for (const filter of config.measureFilters || []) {
        if (filter.column && Number.isFinite(filter.value)) descriptions.push(`${words(filter.column)} ${filter.operator} ${filter.value}`);
    }
    for (const filter of config.dateFilters || []) {
        if (!filter.column || !filter.values?.length) continue;
        const range = filter.values[0]?.split('__');
        descriptions.push(range?.length === 2
            ? `${words(filter.column)} from ${range[0]} to ${range[1]}`
            : `${words(filter.column)}: ${filter.values.slice(0, 2).join(' or ')}${filter.values.length > 2 ? ` and ${filter.values.length - 2} more` : ''}`);
    }
    return descriptions;
};

/** Describes only choices actually present in the Builder configuration. */
export function describeBuilderQuestion(config: BuilderQuestionDescription): string {
    if (!config.metric) return 'Choose a measure to start your question.';

    const primary = measure(config.metric, config.aggregation);
    const extras = (config.secondaryMetrics || []).map(metric =>
        measure(metric, config.secondaryMetricAggregations?.[metric] || 'SUM'));
    const dimension = config.dimension || '';
    const isTime = TIME_GRAINS.has(dimension.toLowerCase());
    const limit = Number(config.limit) || 0;
    let subject: string;

    if (dimension && !isTime && limit > 0 && (config.sort === 'desc' || config.sort === 'asc')) {
        subject = `${config.sort === 'desc' ? 'top' : 'bottom'} ${limit} ${plural(dimension)} by ${primary}`;
    } else if (isTime) {
        subject = `${primary} by ${dimension}`;
    } else if (dimension) {
        subject = `${primary} by ${words(dimension)}`;
    } else {
        subject = primary;
    }

    if (extras.length) subject += `, alongside ${extras.join(' and ')}`;
    const otherGroups = (config.secondaryDimensions || []).filter(field => field && field !== dimension);
    if (otherGroups.length) subject += `, also grouped by ${otherGroups.map(words).join(' and ')}`;
    if (limit > 0 && dimension && (isTime || !['desc', 'asc'].includes(config.sort || ''))) {
        subject += `, limited to ${limit} results`;
    }
    if (config.timeFilter && config.timeFilter !== 'all_time') {
        const time = TIME_FILTERS[config.timeFilter] || words(config.timeFilter);
        subject += ` for ${time}`;
    }
    const filters = describeFilters(config);
    if (filters.length) subject += `, filtered to ${filters.slice(0, 2).join('; ')}${filters.length > 2 ? ` and ${filters.length - 2} more filters` : ''}`;
    if (config.comparison === 'previous_period') subject += ', compared with the previous period';
    else if (config.comparison === 'same_period_last_year') subject += ', compared with the same period last year';
    else if (config.comparison === 'same_period_last_n') {
        const count = config.comparisonOffset || 1;
        const grain = config.comparisonGrain || 'period';
        subject += `, compared with ${count} ${grain}${count === 1 ? '' : 's'} earlier`;
    }
    return `You are viewing ${subject}.`;
}

/** Adds a factual finding only when it can be read unambiguously from the result. */
export function describeBuilderFinding(result: AnalysisResult | undefined, formatting?: FormattingConfig): string | null {
    if (!result) return null;
    if (result.error || result.config?.secondaryMetrics?.length || (result.config?.comparison && result.config.comparison !== 'none')) return null;
    const rows = result.data || [];
    if (!rows.length) return 'No matching data was found for this question.';
    if (rows.length !== 1 || !result.yKey || !result.config?.metric) return null;
    const value = Number(rows[0]?.[result.yKey]);
    if (!Number.isFinite(value)) return null;

    const format = formatting?.numberFormat;
    const rendered = format === 'percent'
        ? `${(Math.abs(value) <= 1 && value !== 0 ? value * 100 : value).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`
        : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    const label = measure(result.config.metric, result.config.aggregation);
    return result.config.dimension && rows[0]?.[result.xKey] != null
        ? `For ${words(result.config.dimension)} ${String(rows[0][result.xKey])}, ${label} is ${rendered}.`
        : `${label.charAt(0).toUpperCase()}${label.slice(1)} is ${rendered}.`;
}
