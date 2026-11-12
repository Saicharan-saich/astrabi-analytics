import type {
    AnalysisPlan,
    ChartRecommendation,
    ResultNarrative,
    ResultProfile,
    SemanticModel,
    SemanticType,
} from './types';
import { correlationInWords, friendlyNumber, plainName } from './plainLabels';

interface ResultNarrativeInput {
    question: string;
    data: Record<string, any>[];
    profile: ResultProfile;
    chart: ChartRecommendation;
    plan: AnalysisPlan;
    model: SemanticModel;
    /** Cleaned rows already present in the browser. Never sent to a model. */
    sourceRows?: Record<string, any>[];
    /** ISO code of the money measure (from the uploaded file), e.g. GBP. */
    currency?: string;
    /** The query, to recognise a correlation (CORR) and name its two measures. */
    sql?: string;
    /** The latest date in the data, for "today" questions on data that is not live. */
    latestDate?: string;
}

/** A rate or share column: "no_show_rate_pct", "share_of_total". Never added up. */
const RATE_NAME = /(rate|pct|percent|percentage|share|ratio|proportion)/i;
/** A gap between two figures. */
const GAP_NAME = /(^|_)(overspend|overspending|underspend|shortfall|loss|losses|variance|difference|diff|gap|deficit|surplus|over_budget|under_budget|delta)($|_)/i;
/** A gap where above zero is bad: money lost or over budget. */
const LOSS_NAME = /(^|_)(overspend|overspending|shortfall|loss|losses|deficit|over_budget)($|_)/i;

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹', JPY: '¥' };
const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayText = (iso: string) => { const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[3])} ${DAY_MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso; };

/** A group's name as people say it: store 45 → "Store 45" (a bare number reads as an amount). */
function groupName(row: Record<string, any>, dimension: string): string {
    const value = row[dimension];
    const text = String(value ?? '(blank)');
    if (/^-?\d+(\.\d+)?$/.test(text) && !/^(19|20)\d{2}$/.test(text)) {
        const name = plainName(dimension).replace(/\s*(id|no|number|code|key)$/i, '').trim() || plainName(dimension);
        return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${text}`;
    }
    return text;
}

/** What the measure is, keeping "average" (words() drops it): "average weekly sales". */
function measureLabel(column: string, input?: { plan: AnalysisPlan }): string {
    const averaged = /^(avg|average|mean)_|_(avg|average|mean)$/i.test(column)
        || Boolean(input?.plan.metrics.length === 1 && input.plan.metrics[0].agg === 'avg' && !/total|sum|count/i.test(column) && !RATE_NAME.test(column));
    const base = (words(column) || 'result').replace(/\s+(pct|percent|percentage)$/i, '');
    return averaged && !/^average\b/i.test(base) ? `average ${base}` : base;
}

// Set for the duration of one buildResultNarrative call (it is synchronous).
// Empty when the file gave no currency: money is then shown as a plain number.
let narrativeCurrency = '';

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-03-01" → "Mar 2026" (month), "Q1 2026", "2026", or "5 Mar 2026". */
function periodText(value: unknown, grain?: string): string {
    const text = String(value ?? '');
    const match = text.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?$/);
    if (!match) return text;
    const year = match[1];
    const month = Number(match[2]) - 1;
    const day = match[3] ? Number(match[3]) : 1;
    if (!SHORT_MONTHS[month]) return text;
    if (grain === 'year') return year;
    if (grain === 'quarter') return `Q${Math.floor(month / 3) + 1} ${year}`;
    if (grain === 'day' || grain === 'week' || day !== 1) return `${day} ${SHORT_MONTHS[month]} ${year}`;
    return `${SHORT_MONTHS[month]} ${year}`;
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
    // Millions and billions read as words: "45.5 million", not "45,544,116.29".
    if (Math.abs(number) >= 1e6 && type !== 'percentage') return friendlyNumber(number, type === 'currency' ? (SYMBOLS[narrativeCurrency] || '') : '');
    if (type === 'percentage') return `${number.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
    if (type === 'currency' && narrativeCurrency) {
        return number.toLocaleString(undefined, {
            style: 'currency', currency: narrativeCurrency, maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
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
    // A correlation: say what the number means, not just the number.
    const corr = (input.sql || '').match(/\bCORR\s*\(\s*"?([A-Za-z0-9_ ]+?)"?\s*,\s*"?([A-Za-z0-9_ ]+?)"?\s*\)/i);
    if (corr || /(^|_)corr(elation)?(_|$)/i.test(metric)) {
        const [x, y] = corr ? [plainName(corr[1]), plainName(corr[2])] : ['the two measures', ''];
        const text = correlationInWords(value, x, y || 'each other');
        return { version: 1, verifiedFrom: 'executed_result', kind: 'kpi', headline: text.headline, summary: text.summary };
    }
    const label = measureLabel(metric, input) || words(input.plan.metrics[0]?.field || '') || 'records';
    const shown = formatValue(value, type);
    // Data is not live: "today" means the latest day in the file.
    const asksToday = /\b(today|today's|todays|now|this week|right now)\b/i.test(input.question);
    const when = asksToday ? (input.latestDate ? ` on ${dayText(input.latestDate)}` : ' today') : '';
    const headline = `${label.charAt(0).toUpperCase() + label.slice(1)}${when}: ${shown}`;
    const note = asksToday && input.latestDate ? ` Your data runs up to ${dayText(input.latestDate)}, so this is the latest day available, not today.` : '';
    const prior = isCountMetric(metric, input) ? previousDayCount(input, metric) : null;
    if (prior !== null) {
        if (prior === 0) {
            return {
                version: 1, verifiedFrom: 'executed_result_and_local_context', kind: 'comparison', headline,
                summary: `${headline}. The day before had none, so there is no percentage change to show.${note}`,
            };
        }
        const pct = ((value - prior) / Math.abs(prior)) * 100;
        const comparison = pct === 0
            ? `the same as the day before (${formatValue(prior, 'count')})`
            : `${Math.abs(pct).toLocaleString('en-GB', { maximumFractionDigits: 1 })}% ${pct > 0 ? 'more' : 'less'} than the day before (${formatValue(prior, 'count')})`;
        return {
            version: 1, verifiedFrom: 'executed_result_and_local_context', kind: 'comparison', headline,
            summary: `${headline}. That is ${comparison}.${note}`,
        };
    }
    return { version: 1, verifiedFrom: 'executed_result', kind: 'kpi', headline, summary: `${headline}.${note}` };
}

export function buildResultNarrative(input: ResultNarrativeInput): ResultNarrative | null {
    if (!input.data?.length) return null;
    narrativeCurrency = input.currency || '';
    const { data, profile, plan } = input;
    let metrics = profile.metricColumns.filter(column => Object.prototype.hasOwnProperty.call(data[0], column));
    // "No-show rate by neighbourhood": lead with the rate, not the count beside it.
    const rateFirst = metrics.find(column => RATE_NAME.test(column));
    if (rateFirst && metrics[0] !== rateFirst && (/\b(rate|share|percent|percentage|proportion|how often|likely)\b|%/i.test(input.question) || !/\b(how many|count|number of|most)\b/i.test(input.question))) {
        metrics = [rateFirst, ...metrics.filter(column => column !== rateFirst)];
    }
    const dimensions = profile.dimensionColumns.filter(column => Object.prototype.hasOwnProperty.call(data[0], column));

    if (data.length === 1 && metrics.length >= 1 && dimensions.length === 0) {
        if (metrics.length === 1) return buildScalarNarrative(input, metrics[0]);
        const parts = metrics.slice(0, 3).map(metric =>
            `${measureLabel(metric)} is ${formatValue(data[0][metric], metricType(metric, profile, input.model))}`
        );
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'kpi',
            headline: 'Your figures',
            summary: `${parts.join('; ')}${metrics.length > 3 ? `; ${metrics.length - 3} more in the table` : ''}.`,
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
        const grain = plan.dimensions.find(dimension => dimension.field === time)?.timeGrain;
        const metric = metrics[0];
        const first = data[0];
        const latest = data[data.length - 1];
        const firstValue = Number(first[metric]);
        const latestValue = Number(latest[metric]);
        const type = metricType(metric, profile, input.model);
        const peak = data.reduce((best, row) => Number(row[metric]) > Number(best[metric]) ? row : best, data[0]);
        const pct = firstValue !== 0 ? ((latestValue - firstValue) / Math.abs(firstValue)) * 100 : null;
        const label = measureLabel(metric, input);
        const Label = label.charAt(0).toUpperCase() + label.slice(1);
        const movement = pct === null ? '' : pct === 0 ? `, the same as in ${periodText(first[time], grain)}` : `, ${Math.abs(pct).toLocaleString('en-GB', { maximumFractionDigits: 1 })}% ${pct >= 0 ? 'up' : 'down'} on ${periodText(first[time], grain)}`;
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'trend',
            headline: `${Label}: ${formatValue(latestValue, type)} in ${periodText(latest[time], grain)}`,
            summary: `${Label} was ${formatValue(latestValue, type)} in ${periodText(latest[time], grain)}${movement}. The best was ${periodText(peak[time], grain)}, at ${formatValue(peak[metric], type)}.`,
        };
    }

    if (dimensions.length >= 1 && metrics.length === 0) {
        const columns = Object.keys(data[0]);
        const sample = data.slice(0, 3).map(row => columns.map(column => String(row[column] ?? '')).filter(Boolean).join(' — '));
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'list',
            headline: `${data.length.toLocaleString()} found`,
            summary: `I found ${data.length.toLocaleString()}${sample.length ? `, including ${sample.join(', ')}` : ''}${data.length > sample.length ? '. The full list is in the table' : ''}.`,
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
        const label = measureLabel(metric, input);
        const runner = ranked[1];
        const last = ranked[ranked.length - 1];
        const averaged = /^average\b/.test(label);
        // Two groups (holiday vs not, online vs in store): say how far apart they are.
        const ranking = plan.intent === 'ranking' || /\b(?:top|highest|most|best|largest|leading)\b/i.test(input.question);
        const isRate = type === 'percentage' || RATE_NAME.test(metric);
        // A gap between two figures (an overspend, a shortfall, a variance): say which groups
        // are on which side of zero, never "X% higher" — a percentage of a gap means nothing.
        if (GAP_NAME.test(metric) && (ranked.length >= 2 || (ranked.length === 1 && LOSS_NAME.test(metric)))) {
            const word = plainName(dimension);
            const Label = label.charAt(0).toUpperCase() + label.slice(1);
            const show = (row: Record<string, any>) => `${groupName(row, dimension)} (${formatValue(row[metric], type)})`;
            const above = ranked.filter(row => Number(row[metric]) > 0);
            const atOrBelow = ranked.filter(row => Number(row[metric]) <= 0);
            const list = (rows: Record<string, any>[]) => rows.length <= 2 ? rows.map(show).join(' and ') : `${rows.slice(0, 3).map(show).join(', ')}${rows.length > 3 ? ` and ${rows.length - 3} more` : ''}`;
            const a = /^[aeiou]/i.test(label) ? 'an' : 'a';
            if (LOSS_NAME.test(metric)) {
                // Over or under, by how much, and how much that is of the group's own plan —
                // 3,814 on a 2.9M budget is on budget, not a loss.
                const planKey = Object.keys(ranked[0]).find(key => key !== metric && /(budget|plan|target|forecast|quota|expected)/i.test(key) && Number.isFinite(Number(ranked[0][key])));
                const planWord = !planKey ? 'plan' : /target/i.test(planKey) ? 'target' : /forecast/i.test(planKey) ? 'forecast' : /budget/i.test(planKey) ? 'budget' : 'plan';
                const shortfall = /(shortfall|deficit|loss)/i.test(metric) && !/(overspend|over_budget)/i.test(metric);
                const [overWord, underWord] = shortfall ? ['short of', 'ahead of'] : ['over', 'under'];
                const amount = (row: Record<string, any>) => formatValue(Math.abs(Number(row[metric])), type);
                const share = (row: Record<string, any>) => {
                    const planned = planKey ? Math.abs(Number(row[planKey])) : 0;
                    if (!planned) return null;
                    return (Math.abs(Number(row[metric])) / planned) * 100;
                };
                const pct = (value: number | null) => value === null ? '' : ` (${value < 0.1 ? 'under 0.1' : value.toLocaleString('en-GB', { maximumFractionDigits: value < 10 ? 1 : 0 })}% of its ${planWord})`;
                const side = (row: Record<string, any>, word: string) => `${groupName(row, dimension)} is ${amount(row)} ${word} ${planWord}${pct(share(row))}`;
                const join = (parts: string[]) => parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
                const total = ranked.reduce((sum, row) => sum + Number(row[metric]), 0);
                const totalPlan = planKey ? ranked.reduce((sum, row) => sum + Math.abs(Number(row[planKey])), 0) : 0;
                const totalLine = ranked.length > 1 && Math.abs(total) > 0
                    ? ` ${ranked.length === 2 ? 'Together' : `Across all ${ranked.length}`}, that is ${formatValue(Math.abs(total), type)} ${total > 0 ? overWord : underWord} ${planWord}${totalPlan ? ` (${(Math.abs(total) / totalPlan * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%)` : ''}.`
                    : '';
                const small = above.length > 0 && above.every(row => { const v = share(row); return v !== null && v < 2; });
                const overParts = above.slice(0, 4).map(row => side(row, overWord));
                const underParts = atOrBelow.slice(0, 3).map(row => Number(row[metric]) === 0 ? `${groupName(row, dimension)} is exactly on ${planWord}` : side(row, underWord));
                return {
                    version: 1, verifiedFrom: 'executed_result', kind: 'ranking',
                    headline: !above.length ? `No ${word} is ${overWord} ${planWord}` : small ? `No ${word} is far ${overWord} ${planWord}` : `${groupName(above[0], dimension)} is furthest ${overWord} ${planWord}`,
                    summary: `${above.length ? `${join(overParts)}${above.length > 4 ? ` and ${above.length - 4} more` : ''}${small ? `, which is close to ${planWord} rather than a real ${label}` : ''}.` : `None of the ${ranked.length} is ${overWord} ${planWord}.`}${underParts.length ? ` ${join(underParts)}${atOrBelow.length > 3 ? ` and ${atOrBelow.length - 3} more` : ''}.` : ''}${totalLine}`,
                };
            }
            return {
                version: 1, verifiedFrom: 'executed_result', kind: 'ranking',
                headline: `${Label}: highest for ${groupName(ranked[0], dimension)}`,
                summary: `${Label} is highest for ${show(ranked[0])} and lowest for ${show(last)}. ${above.length} of ${ranked.length} ${above.length === 1 ? 'is' : 'are'} above 0 and ${atOrBelow.length} at or below 0.`,
            };
        }
        if (!ranking && ranked.length === 2 && isRate) {
            const gap = Number(leader[metric]) - Number(runner[metric]);
            const unit = type === 'percentage' ? ' points' : '';
            return {
                version: 1, verifiedFrom: 'executed_result', kind: 'comparison',
                headline: `${groupName(leader, dimension)}: higher ${label}`,
                summary: `${label.charAt(0).toUpperCase() + label.slice(1)} is ${formatValue(leader[metric], type)} for ${groupName(leader, dimension)} and ${formatValue(runner[metric], type)} for ${groupName(runner, dimension)}, a gap of ${gap.toLocaleString('en-GB', { maximumFractionDigits: 1 })}${unit}.`,
            };
        }
        if (!ranking && ranked.length === 2 && Number(runner[metric])) {
            const gap = (Number(leader[metric]) - Number(runner[metric])) / Math.abs(Number(runner[metric])) * 100;
            return {
                version: 1, verifiedFrom: 'executed_result', kind: 'comparison',
                headline: `${groupName(leader, dimension)}: ${gap.toLocaleString('en-GB', { maximumFractionDigits: 1 })}% higher ${label}`,
                summary: `${label.charAt(0).toUpperCase() + label.slice(1)} is ${gap.toLocaleString('en-GB', { maximumFractionDigits: 1 })}% higher for ${groupName(leader, dimension)} (${formatValue(leader[metric], type)}) than for ${groupName(runner, dimension)} (${formatValue(runner[metric], type)}).`,
            };
        }
        if (ranking) {
            return {
                version: 1, verifiedFrom: 'executed_result', kind: 'ranking',
                headline: `${groupName(leader, dimension)} comes first on ${label}`,
                summary: `${groupName(leader, dimension)} comes first with ${formatValue(leader[metric], type)}${runner ? `, then ${groupName(runner, dimension)} with ${formatValue(runner[metric], type)}` : ''}.${data.length > 2 ? ` ${data.length.toLocaleString()} ${plainName(dimension)} values are ranked in the chart.` : ''}`,
            };
        }
        if (isRate) {
            return {
                version: 1, verifiedFrom: 'executed_result', kind: 'breakdown',
                headline: `${groupName(leader, dimension)} has the highest ${label}`,
                summary: `${groupName(leader, dimension)} has the highest ${label}, at ${formatValue(leader[metric], type)}${last && last !== leader ? `. ${groupName(last, dimension)} has the lowest, at ${formatValue(last[metric], type)}` : ''}.${input.sql && /HAVING\s+COUNT/i.test(input.sql) ? ' Small groups were left out so a handful of rows cannot top the list.' : ''}`,
            };
        }
        return {
            version: 1, verifiedFrom: 'executed_result', kind: 'breakdown',
            headline: `${groupName(leader, dimension)} has the most ${label}`,
            summary: `${groupName(leader, dimension)} has the most ${label}, at ${formatValue(leader[metric], type)}${share !== null && !averaged ? ` (${share.toLocaleString('en-GB', { maximumFractionDigits: 1 })}% of the total shown)` : ''}${last && last !== leader ? `. ${groupName(last, dimension)} has the least, at ${formatValue(last[metric], type)}` : ''}.`,
        };
    }

    const columns = Object.keys(data[0]);
    return {
        version: 1, verifiedFrom: 'executed_result', kind: 'result',
        headline: `${data.length.toLocaleString()} result${data.length === 1 ? '' : 's'}`,
        summary: `Here ${data.length === 1 ? 'is 1 result' : `are ${data.length.toLocaleString()} results`}, showing ${columns.slice(0, 4).map(words).join(', ')}${columns.length > 4 ? ' and more' : ''}.`,
    };
}
