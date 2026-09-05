import type {
    AnalysisPlan,
    ChartRecommendation,
    ResultNarrative,
    ResultProfile,
    SemanticModel,
    SemanticType,
} from './types';

interface ResultNarrativeInput {
    question: string;
    data: Record<string, any>[];
    profile: ResultProfile;
    chart: ChartRecommendation;
    plan: AnalysisPlan;
    model: SemanticModel;
    /** Cleaned rows already present in the browser. Never sent to a model. */
    sourceRows?: Record<string, any>[];
}

function words(value: string): string {
    return value
        .replace(/["`]/g, '')
        .replace(/\([^)]*\)/g, '')
        .replace(/^(?:total|sum|avg|average|maximum|minimum|count(?:_of)?)_/i, '')
        .replace(/_(?:sum|avg|average|count|count_distinct|min|max)$/i, '')
        .replace(/_(?:today|current|value)$/i, '')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function sentenceCase(value: string): string {
    const clean = words(value) || 'result';
    return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function metricType(column: string, profile: ResultProfile, model: SemanticModel): SemanticType {
    const profiled = profile.metricSemanticTypes[column];
    if (profiled) return profiled;
    const base = column.toLowerCase().replace(/_(sum|avg|average|count|count_distinct|min|max)$/i, '');
    return model.fields.find(field => field.name.toLowerCase() === base)?.semanticType || 'quantity';
}

function formatValue(value: unknown, type: SemanticType = 'quantity'): string {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? '');
    if (type === 'percentage') return `${number.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    if (type === 'currency') {
        return number.toLocaleString(undefined, {
            style: 'currency', currency: 'USD', maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
        });
    }
    return number.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(number) ? 0 : 2 });
}

function resolveKey(row: Record<string, any>, field: string): string | null {
    if (field in row) return field;
    const normalized = field.toLowerCase().replace(/[^a-z0-9]/g, '');
    return Object.keys(row).find(key => key.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized) || null;
}

function isoDay(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function previousDay(day: string): string | null {
    const date = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return null;
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
}

function sameField(left: string, right: string): boolean {
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalize(left) === normalize(right);
}

function exactSelectedDay(plan: AnalysisPlan, model: SemanticModel): { field: string; day: string } | null {
    const primaryDate = model.timeContext?.primaryDateColumn;
    const dateFields = model.fields.filter(field => field.semanticType === 'date').map(field => field.name);
    const filter = plan.filters.find(candidate => {
        const isDate = primaryDate ? sameField(candidate.field, primaryDate) : dateFields.some(field => sameField(field, candidate.field));
        if (!isDate || candidate.isHaving) return false;
        if (candidate.op === '=') return Boolean(isoDay(candidate.value));
        if (candidate.op !== 'between' || !Array.isArray(candidate.value) || candidate.value.length < 2) return false;
        const start = isoDay(candidate.value[0]);
        const end = isoDay(candidate.value[1]);
        return Boolean(start && end && start === end);
    });
    if (!filter) return null;
    const value = filter.op === 'between' && Array.isArray(filter.value) ? filter.value[0] : filter.value;
    const day = isoDay(value);
    return day ? { field: filter.field, day } : null;
}

function comparable(left: unknown, right: unknown): number {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
    return String(left ?? '').trim().toLowerCase().localeCompare(String(right ?? '').trim().toLowerCase());
}

function applyFilter(row: Record<string, any>, filter: AnalysisPlan['filters'][number]): boolean | null {
    if (filter.isHaving || filter.op === 'above_avg' || filter.op === 'below_avg'
        || filter.op.startsWith('this_')) return null;
    const key = resolveKey(row, filter.field);
    if (!key) return null;
    const actual = row[key];
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    switch (filter.op) {
        case '=': return comparable(actual, filter.value) === 0;
        case '!=': return comparable(actual, filter.value) !== 0;
        case '>': return comparable(actual, filter.value) > 0;
        case '<': return comparable(actual, filter.value) < 0;
        case '>=': return comparable(actual, filter.value) >= 0;
        case '<=': return comparable(actual, filter.value) <= 0;
        case 'in': return values.some(value => comparable(actual, value) === 0);
        case 'not_in': return values.every(value => comparable(actual, value) !== 0);
        case 'between': return values.length >= 2 && comparable(actual, values[0]) >= 0 && comparable(actual, values[1]) <= 0;
        case 'like': {
            const pattern = String(filter.value ?? '').replace(/^%|%$/g, '').toLowerCase();
            return String(actual ?? '').toLowerCase().includes(pattern);
        }
        default: return null;
    }
}

function previousDayCount(input: ResultNarrativeInput, metricColumn: string): number | null {
    const selected = exactSelectedDay(input.plan, input.model);
    const rows = input.sourceRows;
    if (!selected || !rows?.length) return null;
    const prior = previousDay(selected.day);
    if (!prior) return null;

    const nonDateFilters = input.plan.filters.filter(filter => !sameField(filter.field, selected.field));
    const matched: Record<string, any>[] = [];
    for (const row of rows) {
        const dateKey = resolveKey(row, selected.field);
        if (!dateKey) return null;
        if (isoDay(row[dateKey]) !== prior) continue;
        let supported = true;
        let included = true;
        for (const filter of nonDateFilters) {
            const outcome = applyFilter(row, filter);
            if (outcome === null) { supported = false; break; }
            if (!outcome) { included = false; break; }
        }
        if (!supported) return null;
        if (included) matched.push(row);
    }

    const metric = input.plan.metrics[0];
    if (metric?.agg === 'count_distinct' && metric.field && metric.field !== '*') {
        const values = matched.map(row => {
            const key = resolveKey(row, metric.field);
            return key ? row[key] : null;
        }).filter(value => value !== null && value !== undefined);
        return new Set(values.map(value => String(value))).size;
    }
    if (metric?.agg === 'count' && metric.field && metric.field !== '*') {
        const canResolve = matched.length === 0 || resolveKey(matched[0], metric.field);
        if (canResolve) return matched.filter(row => {
            const key = resolveKey(row, metric.field);
            return key && row[key] !== null && row[key] !== undefined;
        }).length;
    }
    // COUNT(*) and generic row-count aliases use the requested filtered grain.
    if (metric?.agg === 'count' || /count|number|volume/i.test(metricColumn)) return matched.length;
    return null;
}

function isCountMetric(column: string, input: ResultNarrativeInput): boolean {
    return input.plan.metrics.some(metric => metric.agg === 'count' || metric.agg === 'count_distinct')
        || input.profile.metricSemanticTypes[column] === 'count'
        || /(?:^|_)(?:count|number|volume)(?:_|$)/i.test(column);
}

function buildScalarNarrative(input: ResultNarrativeInput, metric: string): ResultNarrative {
    const value = Number(input.data[0][metric]);
    const type = metricType(metric, input.profile, input.model);
    const label = words(metric) || words(input.plan.metrics[0]?.field || '') || 'records';
    const when = /\btoday\b/i.test(input.question) ? ' today' : '';
    const headline = `${formatValue(value, type)} ${label}${when}`.replace(/\s+/g, ' ').trim();
    const prior = isCountMetric(metric, input) ? previousDayCount(input, metric) : null;
    if (prior !== null) {
        if (prior === 0) {
            return {
                version: 1,
                verifiedFrom: 'executed_result_and_local_context',
                kind: 'comparison',
                headline,
                summary: `${headline}. The previous day had no matching ${label}, so a percentage change is not meaningful.`,
            };
        }
        const pct = ((value - prior) / Math.abs(prior)) * 100;
        const direction = pct > 0 ? 'higher' : pct < 0 ? 'lower' : 'the same';
        const comparison = direction === 'the same'
            ? `the same as the previous day (${formatValue(prior, 'count')})`
            : `${Math.abs(pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}% ${direction} than the previous day (${formatValue(prior, 'count')})`;
        return {
            version: 1,
            verifiedFrom: 'executed_result_and_local_context',
            kind: 'comparison',
            headline,
            summary: `${headline}. That is ${comparison}.`,
        };
    }
    return {
        version: 1,
        verifiedFrom: 'executed_result',
        kind: 'kpi',
        headline,
        summary: `${headline}. This is the value for the filters and period in your question.`,
    };
}

export function buildResultNarrative(input: ResultNarrativeInput): ResultNarrative | null {
    if (!input.data?.length) return null;
    const { data, profile, plan } = input;
    const metrics = profile.metricColumns.filter(column => Object.prototype.hasOwnProperty.call(data[0], column));
    const dimensions = profile.dimensionColumns.filter(column => Object.prototype.hasOwnProperty.call(data[0], column));

    if (data.length === 1 && metrics.length >= 1 && dimensions.length === 0) {
        if (metrics.length === 1) return buildScalarNarrative(input, metrics[0]);
        const parts = metrics.slice(0, 3).map(metric =>
            `${words(metric)} is ${formatValue(data[0][metric], metricType(metric, profile, input.model))}`
        );
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'kpi',
            headline: 'Summary of the requested measures',
            summary: `${parts.join(', ')}${metrics.length > 3 ? `, with ${metrics.length - 3} additional measure${metrics.length - 3 === 1 ? '' : 's'} in the table` : ''}.`,
        };
    }

    const period = dimensions.find(column => column.toLowerCase() === 'period');
    if (period && metrics.length >= 1 && data.length >= 2) {
        const metric = metrics[0];
        const current = data.find(row => /current|this/i.test(String(row[period]))) || data[data.length - 1];
        const previous = data.find(row => /previous|prior|last/i.test(String(row[period]))) || data[0];
        const currentValue = Number(current[metric]);
        const previousValue = Number(previous[metric]);
        const type = metricType(metric, profile, input.model);
        const pct = previousValue !== 0 ? ((currentValue - previousValue) / Math.abs(previousValue)) * 100 : null;
        const change = pct === null
            ? 'A percentage change is not meaningful because the previous value was zero'
            : `${Math.abs(pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}% ${pct > 0 ? 'higher' : pct < 0 ? 'lower' : 'unchanged'}`;
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'comparison',
            headline: `${sentenceCase(metric)}: ${formatValue(currentValue, type)}`,
            summary: `${sentenceCase(metric)} is ${formatValue(currentValue, type)} for ${String(current[period]).toLowerCase()}, compared with ${formatValue(previousValue, type)} for ${String(previous[period]).toLowerCase()}. ${change}.`,
        };
    }

    if (profile.hasTimeDimension && profile.timeDimensionColumn && metrics.length >= 1 && data.length > 1) {
        const time = profile.timeDimensionColumn;
        const metric = metrics[0];
        const first = data[0];
        const latest = data[data.length - 1];
        const firstValue = Number(first[metric]);
        const latestValue = Number(latest[metric]);
        const type = metricType(metric, profile, input.model);
        const peak = data.reduce((best, row) => Number(row[metric]) > Number(best[metric]) ? row : best, data[0]);
        const pct = firstValue !== 0 ? ((latestValue - firstValue) / Math.abs(firstValue)) * 100 : null;
        const movement = pct === null ? '' : `, ${Math.abs(pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}% ${pct >= 0 ? 'higher' : 'lower'} than the first period shown`;
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'trend',
            headline: `${sentenceCase(metric)} is ${formatValue(latestValue, type)} in the latest period`,
            summary: `${sentenceCase(metric)} is ${formatValue(latestValue, type)} for ${latest[time]}${movement}. The highest point shown is ${formatValue(peak[metric], type)} for ${peak[time]}.`,
        };
    }

    if (dimensions.length >= 1 && metrics.length === 0) {
        const columns = Object.keys(data[0]);
        const sample = data.slice(0, 3).map(row => columns.map(column => String(row[column] ?? '')).filter(Boolean).join(' — '));
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'list',
            headline: `${data.length.toLocaleString()} result${data.length === 1 ? '' : 's'} found`,
            summary: `${data.length.toLocaleString()} matching result${data.length === 1 ? ' was' : 's were'} found${sample.length ? `, including ${sample.join(', ')}` : ''}${data.length > sample.length ? '. The full list is available in the table' : ''}.`,
        };
    }

    if (dimensions.length >= 1 && metrics.length >= 1) {
        const dimension = dimensions[0];
        const metric = metrics[0];
        const type = metricType(metric, profile, input.model);
        const ranked = [...data].filter(row => Number.isFinite(Number(row[metric])))
            .sort((a, b) => Number(b[metric]) - Number(a[metric]));
        const leader = ranked[0] || data[0];
        const total = ranked.reduce((sum, row) => sum + Number(row[metric] || 0), 0);
        const share = total !== 0 ? Number(leader[metric]) / total * 100 : null;
        if (plan.intent === 'ranking' || /\b(?:top|highest|most|best|largest|leading)\b/i.test(input.question)) {
            const runner = ranked[1];
            return {
                version: 1, verifiedFrom: 'executed_result', kind: 'ranking',
                headline: `${leader[dimension]} leads on ${words(metric)}`,
                summary: `${leader[dimension]} leads with ${formatValue(leader[metric], type)}${runner ? `, followed by ${runner[dimension]} with ${formatValue(runner[metric], type)}` : ''}. The result contains ${data.length.toLocaleString()} ranked ${words(dimension)} value${data.length === 1 ? '' : 's'}.`,
            };
        }
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'breakdown',
            headline: `${leader[dimension]} has the largest ${words(metric)}`,
            summary: `Across ${data.length.toLocaleString()} ${words(dimension)} value${data.length === 1 ? '' : 's'}, ${leader[dimension]} has the largest ${words(metric)} at ${formatValue(leader[metric], type)}${share !== null ? `, representing ${share.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of the displayed total` : ''}.`,
        };
    }

    const columns = Object.keys(data[0]);
    return {
        version: 1, verifiedFrom: 'executed_result', kind: 'result',
        headline: `${data.length.toLocaleString()} result row${data.length === 1 ? '' : 's'}`,
        summary: `The query returned ${data.length.toLocaleString()} row${data.length === 1 ? '' : 's'} across ${columns.length.toLocaleString()} field${columns.length === 1 ? '' : 's'}: ${columns.slice(0, 4).map(words).join(', ')}${columns.length > 4 ? ', and more' : ''}.`,
    };
}
