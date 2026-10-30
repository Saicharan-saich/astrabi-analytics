/**
 * Shape-based chart suggestions.
 *
 * Looks at the result itself (how many categories, whether the x-axis is time
 * or geography, whether the measure adds up, whether values go negative) and
 * returns the chart that fits best plus a few honest alternatives. The goal is
 * variety that still tells the truth: a donut only for a few parts of a whole,
 * a treemap only when there are many additive parts, a waterfall only for a
 * measure that adds up, a map only when the labels really are places.
 *
 * Pure and dependency-free so the Question Builder, AI SQL and dashboards can
 * all share it, and it is easy to unit test.
 */

export type SuggestedChartType =
    | 'bar' | 'horizontalBar' | 'stackedBar' | 'groupedBar'
    | 'line' | 'area' | 'stackedArea' | 'steppedLine' | 'curvedLine'
    | 'pie' | 'doughnut' | 'polarArea' | 'radar'
    | 'treemap' | 'map' | 'waterfall' | 'funnel' | 'lollipop' | 'gauge' | 'kpiCard' | 'combo';

export interface ChartSuggestion {
    type: SuggestedChartType;
    /** Short chip label, e.g. "Donut". */
    label: string;
    /** Why it fits, e.g. "share of 4 categories". */
    reason: string;
}

export interface ChartShapeInput {
    rows: Record<string, any>[];
    xKey: string;
    yKey: string;
    /** Builder dimension name (helps recognise time and stage fields). */
    dimension?: string;
    aggregation?: string;
    /** Extra metrics plotted alongside the primary one. */
    secondaryYKeys?: string[];
    /** A second grouping field that splits the chart into series. */
    seriesKey?: string;
    hasComparison?: boolean;
    sort?: string;
    limit?: number;
    kpiGoal?: number;
}

export interface ChartShape {
    kind: 'empty' | 'single' | 'time' | 'category';
    categoryCount: number;
    seriesCount: number;
    metricCount: number;
    geography: 'us' | 'world' | null;
    isStage: boolean;
    isPercent: boolean;
    additive: boolean;
    hasNegatives: boolean;
    longLabels: boolean;
    ranked: boolean;
}

const LABELS: Record<SuggestedChartType, string> = {
    bar: 'Bars', horizontalBar: 'Horizontal bars', stackedBar: 'Stacked bars', groupedBar: 'Grouped bars',
    line: 'Line', area: 'Area', stackedArea: 'Stacked area', steppedLine: 'Steps', curvedLine: 'Smooth line',
    pie: 'Pie', doughnut: 'Donut', polarArea: 'Polar area', radar: 'Radar',
    treemap: 'Treemap', map: 'Map', waterfall: 'Waterfall', funnel: 'Funnel', lollipop: 'Lollipop',
    gauge: 'Gauge', kpiCard: 'Number', combo: 'Combo',
};

const TIME_NAMES = new Set(['minute', 'hour', 'day', 'date', 'week', 'month', 'quarter', 'year', 'period', 'weekday', 'day_of_week']);
const TIME_VALUE = [
    /^\d{4}(-\d{1,2}(-\d{1,2})?)?([ T]\d{1,2}:\d{2}.*)?$/, // 2024, 2024-03, 2024-03-01
    /^\d{4}[- ]?Q[1-4]$/i, /^Q[1-4][ -]?\d{4}$/i, // 2024-Q1, Q1 2024
    /^\d{4}-W\d{1,2}$/i, // 2024-W12
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?( '?\d{2,4})?$/i,
    /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/i,
    /^\d{1,2}:\d{2}$/,
];
const STAGE_NAME = /(^|_|\b)(stage|step|funnel|phase|pipeline|journey)(s)?($|_|\b)/i;
const PERCENT_NAME = /(percent|pct|ratio|rate|share|margin_pct|conversion|_%|%)/i;
const NON_ADDITIVE_NAME = /(^|_)(avg|average|mean|median|min|max|minimum|maximum|stddev|std)(_|$)/i;
const RATE_EXCEPTIONS = /\b(hourly|daily|weekly|monthly|annual|yearly|billing|pay|base|flat)[_ ]?rate\b/i;

const US_STATES = new Set(['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'district of columbia']);
// Names as they appear in the world map (plus common aliases resolved by MapChart).
export const WORLD_COUNTRIES = new Set(['afghanistan', 'albania', 'algeria', 'angola', 'argentina', 'armenia', 'australia', 'austria', 'azerbaijan', 'bangladesh', 'belarus', 'belgium', 'bolivia', 'bosnia and herz.', 'botswana', 'brazil', 'bulgaria', 'cambodia', 'cameroon', 'canada', 'chile', 'china', 'colombia', 'costa rica', 'croatia', 'cuba', 'cyprus', 'czechia', 'denmark', 'dominican rep.', 'ecuador', 'egypt', 'estonia', 'ethiopia', 'finland', 'france', 'georgia', 'germany', 'ghana', 'greece', 'guatemala', 'hungary', 'iceland', 'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica', 'japan', 'jordan', 'kazakhstan', 'kenya', 'kuwait', 'latvia', 'lebanon', 'libya', 'lithuania', 'luxembourg', 'madagascar', 'malaysia', 'mexico', 'mongolia', 'morocco', 'mozambique', 'myanmar', 'nepal', 'netherlands', 'new zealand', 'nicaragua', 'nigeria', 'north korea', 'norway', 'oman', 'pakistan', 'panama', 'paraguay', 'peru', 'philippines', 'poland', 'portugal', 'qatar', 'romania', 'russia', 'saudi arabia', 'senegal', 'serbia', 'singapore', 'slovakia', 'slovenia', 'somalia', 'south africa', 'south korea', 'spain', 'sri lanka', 'sudan', 'sweden', 'switzerland', 'syria', 'taiwan', 'tanzania', 'thailand', 'tunisia', 'turkey', 'uganda', 'ukraine', 'united arab emirates', 'united kingdom', 'united states of america', 'uruguay', 'uzbekistan', 'venezuela', 'vietnam', 'yemen', 'zambia', 'zimbabwe']);
export const COUNTRY_ALIASES: Record<string, string> = {
    'usa': 'united states of america', 'us': 'united states of america', 'u.s.': 'united states of america', 'u.s.a.': 'united states of america',
    'united states': 'united states of america', 'america': 'united states of america',
    'uk': 'united kingdom', 'u.k.': 'united kingdom', 'great britain': 'united kingdom', 'britain': 'united kingdom', 'england': 'united kingdom', 'scotland': 'united kingdom', 'wales': 'united kingdom',
    'uae': 'united arab emirates', 'czech republic': 'czechia', 'republic of korea': 'south korea', 'korea': 'south korea',
    'russian federation': 'russia', 'holland': 'netherlands', 'the netherlands': 'netherlands', 'türkiye': 'turkey', 'turkiye': 'turkey',
    'viet nam': 'vietnam', 'bosnia and herzegovina': 'bosnia and herz.', 'dominican republic': 'dominican rep.',
};

/** Lower-cased world-map name for a label, or null when it is not a known country. */
export function resolveCountryName(label: string): string | null {
    const key = label.trim().toLowerCase();
    const resolved = COUNTRY_ALIASES[key] || key;
    return WORLD_COUNTRIES.has(resolved) ? resolved : null;
}

function isTimeLabel(value: unknown): boolean {
    if (value instanceof Date) return true;
    const text = String(value ?? '').trim();
    return text.length > 0 && TIME_VALUE.some(pattern => pattern.test(text));
}

function detectGeography(labels: string[]): ChartShape['geography'] {
    if (labels.length < 3) return null;
    const lower = labels.map(label => label.trim().toLowerCase());
    const states = lower.filter(label => US_STATES.has(label)).length;
    if (states / lower.length >= 0.6) return 'us';
    const countries = lower.filter(label => resolveCountryName(label)).length;
    if (countries / lower.length >= 0.6) return 'world';
    return null;
}

export function profileChartShape(input: ChartShapeInput): ChartShape {
    const rows = Array.isArray(input.rows) ? input.rows : [];
    const metricKeys = [input.yKey, ...(input.secondaryYKeys || [])].filter(Boolean);
    const labels = [...new Set(rows.map(row => String(row?.[input.xKey] ?? '')))];
    const series = input.seriesKey ? new Set(rows.map(row => String(row?.[input.seriesKey!] ?? ''))) : null;
    const values = rows.map(row => Number(row?.[input.yKey])).filter(Number.isFinite);
    const aggregation = String(input.aggregation || '').toUpperCase();
    const metricName = `${input.yKey}`;
    const isPercent = (PERCENT_NAME.test(metricName) && !RATE_EXCEPTIONS.test(metricName));
    const additive = !isPercent && !NON_ADDITIVE_NAME.test(metricName) && (aggregation === '' || aggregation === 'SUM' || aggregation === 'COUNT' || aggregation === 'COUNT_DISTINCT');
    const dimensionName = String(input.dimension || input.xKey || '').toLowerCase();
    const sampled = labels.slice(0, 40);
    const timeByName = TIME_NAMES.has(dimensionName) || /(_date|_at|_time|_month|_year|_week|_day)$/.test(dimensionName);
    const timeByValue = sampled.length > 0 && sampled.filter(isTimeLabel).length / sampled.length >= 0.8;

    let kind: ChartShape['kind'];
    if (rows.length === 0) kind = 'empty';
    else if (!input.xKey || labels.length <= 1 && !series) kind = rows.length <= 1 ? 'single' : 'category';
    else if (timeByValue || (timeByName && labels.length > 1)) kind = 'time';
    else kind = 'category';

    const avgLabelLength = labels.length ? labels.reduce((sum, label) => sum + label.length, 0) / labels.length : 0;
    const sort = String(input.sort || '').toLowerCase();
    return {
        kind,
        categoryCount: labels.length,
        seriesCount: series && series.size > 1 ? series.size : 1,
        metricCount: metricKeys.length,
        geography: kind === 'category' ? detectGeography(labels) : null,
        isStage: STAGE_NAME.test(dimensionName),
        isPercent,
        additive,
        hasNegatives: values.some(value => value < 0),
        longLabels: avgLabelLength > 12,
        ranked: (sort === 'desc' || sort === 'asc') && Boolean(input.limit && input.limit > 0 && input.limit <= 25),
    };
}

const pick = (type: SuggestedChartType, reason: string): ChartSuggestion => ({ type, label: LABELS[type], reason });

/**
 * Rank chart types for this result. `best` is the recommended default; the
 * list holds every chart that fits, best first, without duplicates.
 */
export function suggestCharts(input: ChartShapeInput): { best: ChartSuggestion | null; suggestions: ChartSuggestion[]; shape: ChartShape } {
    const shape = profileChartShape(input);
    const list: ChartSuggestion[] = [];
    const add = (type: SuggestedChartType, reason: string) => {
        if (!list.some(item => item.type === type)) list.push(pick(type, reason));
    };
    const n = shape.categoryCount;
    const parts = `${n} ${n === 1 ? 'category' : 'categories'}`;

    if (shape.kind === 'empty') return { best: null, suggestions: [], shape };

    if (shape.kind === 'single') {
        add('kpiCard', 'one headline number');
        if (shape.isPercent || (input.kpiGoal && input.kpiGoal > 0)) add('gauge', input.kpiGoal ? 'progress towards the goal' : 'a rate out of 100%');
        return { best: list[0], suggestions: list, shape };
    }

    // Period comparisons are drawn as a current + previous pair; only charts
    // with an axis can show both honestly.
    if (input.hasComparison) {
        if (shape.kind === 'time') {
            add(n <= 4 ? 'bar' : 'line', n <= 4 ? 'few periods side by side' : 'this period against the last');
            add('area', 'trend with volume');
            add('bar', 'period by period');
        } else {
            add(shape.longLabels || n > 8 ? 'horizontalBar' : 'bar', 'current against previous');
            add(shape.longLabels || n > 8 ? 'bar' : 'horizontalBar', 'same values, other orientation');
        }
        return { best: list[0], suggestions: list, shape };
    }

    // Several measures at once.
    if (shape.metricCount > 1) {
        add('combo', 'bars with a line for the second measure');
        add('groupedBar', 'measures side by side');
        if (shape.kind === 'time') add('line', 'every measure as a trend');
        if (shape.kind === 'category' && n >= 3 && n <= 10) add('radar', 'profile across categories');
        return { best: list[0], suggestions: list, shape };
    }

    // Split into series by a second field.
    if (shape.seriesCount > 1) {
        if (shape.kind === 'time') {
            if (shape.additive && !shape.hasNegatives) add('stackedArea', 'how each group builds the total');
            add('line', 'one trend per group');
            if (shape.additive) add('stackedBar', 'totals per period, split by group');
            add('groupedBar', 'groups side by side');
        } else {
            if (shape.additive && !shape.hasNegatives) add('stackedBar', 'totals split by group');
            add('groupedBar', 'groups side by side');
            if (n >= 3 && n <= 10 && shape.seriesCount <= 5) add('radar', 'compare group profiles');
            add('horizontalBar', 'readable long labels');
        }
        return { best: list[0], suggestions: list, shape };
    }

    if (shape.kind === 'time') {
        if (n <= 3) {
            add('bar', `only ${n} periods`);
            add('line', 'trend');
        } else if (shape.hasNegatives) {
            add('bar', 'gains and losses per period');
            add('line', 'trend');
            if (shape.additive) add('waterfall', 'running total, period by period');
        } else if (shape.additive) {
            add('area', 'volume over time');
            add('line', 'trend');
            add('bar', 'period by period');
            if (n <= 24) add('waterfall', 'how the total built up');
        } else {
            add('line', shape.isPercent ? 'rate over time' : 'average over time');
            add('steppedLine', 'level changes between periods');
            add('area', 'trend with emphasis');
            add('bar', 'period by period');
        }
        return { best: list[0], suggestions: list, shape };
    }

    // ── Categories ──────────────────────────────────────────────────────
    const canPartToWhole = shape.additive && !shape.hasNegatives && !shape.ranked;
    if (shape.geography && n >= 3) add('map', shape.geography === 'us' ? `${n} US states` : `${n} countries`);
    if (shape.isStage && n >= 2 && n <= 10 && !shape.hasNegatives) add('funnel', 'drop-off between stages');

    if (shape.hasNegatives) {
        if (shape.additive) add('waterfall', 'what adds and what takes away');
        add(shape.longLabels || n > 8 ? 'horizontalBar' : 'bar', 'positive and negative values');
        add('lollipop', 'values around zero');
    } else if (shape.ranked) {
        add(n > 10 ? 'lollipop' : 'horizontalBar', `top ${n} ranked`);
        add(n > 10 ? 'horizontalBar' : 'lollipop', 'ranking');
        if (shape.additive && n >= 5) add('treemap', 'relative size');
        add('bar', 'ranking');
    } else if (canPartToWhole && n >= 2 && n <= 6) {
        add('doughnut', `share of ${parts}`);
        add(shape.longLabels ? 'horizontalBar' : 'bar', 'exact comparison');
        if (n >= 3) add('treemap', 'relative size');
        add('pie', `share of ${parts}`);
        if (n >= 3) add('polarArea', 'size as radius');
    } else if (canPartToWhole && n <= 12) {
        add(shape.longLabels ? 'horizontalBar' : 'bar', `${parts}`);
        add('treemap', 'relative size of each part');
        add('lollipop', 'clean ranking');
        if (n <= 8) add('doughnut', `share of ${parts}`);
    } else if (canPartToWhole && n <= 60) {
        add('treemap', `${parts} as parts of the whole`);
        add('horizontalBar', 'readable ranking');
        add('lollipop', 'clean ranking');
    } else if (canPartToWhole) {
        add('horizontalBar', `top categories of ${n}`);
        add('treemap', 'relative size');
    } else {
        // Averages, rates, maxima: compare, never sum into a whole.
        if (n >= 5 && n <= 25) add('lollipop', shape.isPercent ? 'rate per category' : 'value per category');
        add(shape.longLabels || n > 10 ? 'horizontalBar' : 'bar', 'compare categories');
        if (n >= 3 && n <= 10) add('radar', 'profile across categories');
        if (n <= 12) add(shape.longLabels || n > 10 ? 'bar' : 'horizontalBar', 'other orientation');
    }
    if (list.length < 3 && !list.some(item => item.type === 'bar')) add('bar', 'compare categories');
    return { best: list[0], suggestions: list, shape };
}

export function chartSuggestionLabel(type: string): string {
    return (LABELS as Record<string, string>)[type] || type;
}

/**
 * Identity of a builder question's shape. A chart the user picks is kept
 * while this stays the same (filters, time range and sort may change).
 */
export function chartShapeSignature(config: Record<string, any> | null | undefined): string {
    if (!config) return '';
    return JSON.stringify([
        config.metric || '',
        config.dimension || '',
        String(config.aggregation || ''),
        config.secondaryDimensions || [],
        config.secondaryMetrics || [],
        config.comparison && config.comparison !== 'none' ? config.comparison : '',
    ]);
}

// Generic picks that a richer chart can replace without changing what the
// answer says (AI SQL keeps its specialised choices: combos, KPIs, tables…).
const GENERIC_UPGRADES: Record<string, SuggestedChartType[]> = {
    bar: ['doughnut', 'treemap', 'map', 'funnel', 'waterfall', 'lollipop', 'horizontalBar'],
    line: ['area'],
};

/** Swap a plain bar/line default for the chart that fits the shape better. */
export function refineGenericChart(current: string, input: ChartShapeInput): string {
    const allowed = GENERIC_UPGRADES[current];
    if (!allowed || (input.secondaryYKeys?.length || 0) > 0) return current;
    const best = suggestCharts(input).best?.type;
    return best && allowed.includes(best) ? best : current;
}

const AI_SQL_CHART_MAP: Record<string, string> = {
    kpiCard: 'kpiCard', line: 'line', bar: 'bar', horizontalBar: 'horizontalBar',
    groupedBar: 'groupedBar', stackedBar: 'stackedBar', area: 'area',
    dualAxisCombo: 'combo', multiLine: 'line', donut: 'doughnut', pie: 'pie',
    heatmap: 'bar', table: 'horizontalBar',
};

/** Chart to show for an AI SQL answer: its recommendation, with plain bar/line upgraded by shape. */
export function aiSqlPresentationChart(res: {
    chartData: Record<string, any>[];
    chart: { chartType: string; xKey: string; yKey: string; secondaryYKeys?: string[] };
    plan?: { limit?: number | null; sort?: { dir?: string }[]; dimensions?: { field?: string }[] };
}): string {
    const base = AI_SQL_CHART_MAP[res.chart.chartType] || 'bar';
    return refineGenericChart(base, {
        rows: res.chartData || [],
        xKey: res.chart.xKey,
        yKey: res.chart.yKey,
        secondaryYKeys: res.chart.secondaryYKeys,
        dimension: res.plan?.dimensions?.[0]?.field,
        sort: res.plan?.sort?.[0]?.dir,
        limit: res.plan?.limit ?? undefined,
    });
}
