/**
 * Ask in your own words, set up by the AI.
 *
 * The AI gets the question and a description of the file (column names,
 * kinds, how many different values each has, the dates it covers and the
 * As of date), never rows or cell values. It returns builder settings
 * across Build, Time, Compare and Calc. Everything it returns is checked
 * here before it is used: unknown columns, settings and malformed periods
 * are dropped, and filter words from the question are matched to the
 * file's real values on this computer. If the AI can't be reached, the
 * question is read on this computer instead.
 */
import type { Dataset } from '../types';
import { ColumnType } from '../types';
import { fetchWithFallback, PLANNER_MODEL } from './ai-sql/modelConfig';
import { questionFromWords, type Understood } from './builderFromWords';
import { primaryDateColumn } from '../utils/explore';
import type { TableCalculation } from '../utils/tableCalculations';

export interface BuilderAnswerPlan {
    config: Record<string, any>;
    /** A calculation for the Calc tab, or none. */
    calculation: TableCalculation | null;
    understood: Understood[];
    /** The AI's reading of the question, in one sentence. */
    reading?: string;
    /** Parts of the question that couldn't be set (a value not in the file…). */
    notes: string[];
    source: 'ai' | 'local';
    /** Why the AI wasn't used, when it wasn't. */
    fallbackReason?: string;
}

const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const AGGS = ['SUM', 'AVG', 'COUNT', 'COUNT_DISTINCT', 'MAX', 'MIN'];
const TIME_PRESETS = ['all_time', 'today', 'yesterday', 'this_week', 'this_month', 'this_quarter', 'this_year', 'last_7_days', 'last_30_days', 'last_90_days', 'last_year'];
const CALCS: TableCalculation[] = ['percent_of_total', 'running_total', 'moving_avg', 'pct_diff_from_prev', 'diff_from_prev', 'rank_desc', 'rank_asc', 'linear_forecast'];
const CALC_WORDS: Record<string, string> = {
    percent_of_total: 'share of the total', running_total: 'running total', moving_avg: 'moving average', pct_diff_from_prev: '% change from the one before',
    diff_from_prev: 'change from the one before', rank_desc: 'rank, highest first', rank_asc: 'rank, lowest first', linear_forecast: 'trend forecast',
};
const words = (s: string) => s.replace(/_/g, ' ').trim();
const norm = (s: string) => String(s).toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9£$€%.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
const singular = (w: string) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/(ches|shes|xes|sses)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1') : w);

const KIND: Record<string, string> = {
    [ColumnType.METRIC]: 'number', [ColumnType.DIMENSION]: 'category', [ColumnType.DATE]: 'date',
    [ColumnType.ID]: 'id', [ColumnType.BOOLEAN]: 'yes/no', [ColumnType.UNKNOWN]: 'text',
};

/** What the AI is told about the file: names, kinds, counts and the date span. No rows, no cell values. */
export function builderMetadata(dataset: Dataset, asOf?: string) {
    const rows = dataset.rows || [];
    const sample = rows.length > 20000 ? rows.slice(0, 20000) : rows;
    const dateColumn = primaryDateColumn(dataset);
    let first = ''; let last = '';
    if (dateColumn) for (const row of rows) {
        const k = String(row[dateColumn] ?? '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
        if (!first || k < first) first = k;
        if (!last || k > last) last = k;
    }
    return {
        file: dataset.name,
        rows: rows.length,
        asOf: asOf || last || undefined,
        dateColumn: dateColumn || undefined,
        datesFrom: first || undefined,
        datesTo: last || undefined,
        columns: dataset.columns.filter(c => !c.name.startsWith('__')).map(c => {
            const seen = new Set<string>();
            if (c.type === ColumnType.DIMENSION || c.type === ColumnType.BOOLEAN) {
                for (const row of sample) { const v = row[c.name]; if (v !== null && v !== undefined && v !== '') seen.add(String(v)); if (seen.size > 500) break; }
            }
            return { name: c.name, kind: KIND[c.type] || 'text', ...(seen.size ? { differentValues: seen.size > 500 ? '500+' : seen.size } : {}) };
        }),
    };
}

const SYSTEM = `You set up a Question Builder for a business user from their question.
You get the question and a description of their file: column names, kinds and how many different values each category has. You never see the data.
Reply with JSON only, no prose, in this shape:
{
  "metric": "<column>",                     // the measure; a number column, or an id column with COUNT_DISTINCT for "how many orders"
  "aggregation": "SUM|AVG|COUNT|COUNT_DISTINCT|MAX|MIN",
  "dimension": "<category or date column> | day|week|month|quarter|year | \\"\\"",   // "" = one total
  "secondaryDimensions": ["<column>"],      // optional, at most 2
  "secondaryMetrics": ["<number column>"], // optional, at most 3, plotted alongside
  "timeFilter": "all_time|today|yesterday|this_week|this_month|this_quarter|this_year|last_7_days|last_30_days|last_90_days|last_year|last_<N>_days|last_<N>_weeks|last_<N>_months|last_<N>_years",
  "dateFilters": [{"grain": "year|quarter|month|day", "values": ["2025" | "2025-Q2" | "2025-03" | "2025-03-01__2025-03-31"]}],  // calendar periods; work them out from asOf
  "filters": {"<category column>": ["<value words exactly as the user wrote them>"]},
  "exclude": {"<category column>": ["<value words>"]},
  "sort": "desc|asc|oldest|newest",
  "limit": 0,                               // N = top N, -N = bottom N, 0 = all
  "comparison": "none|previous_period|same_period_last_n",
  "comparisonGrain": "day|week|month|quarter|year",
  "comparisonOffset": 1,
  "calculation": "none|percent_of_total|running_total|moving_avg|pct_diff_from_prev|diff_from_prev|rank_desc|rank_asc|linear_forecast",
  "reading": "<one short sentence saying what you set up>"
}
Rules:
- Use only column names from the file description, spelled exactly.
- "sales", "revenue", "takings" mean the main money column; pick the closest column name.
- Relative periods are worked out from asOf by the app: prefer timeFilter presets for "this …", "last N …".
- "this month vs last month", "compare this and last month": timeFilter "this_month", comparison "previous_period", comparisonGrain "month", dimension "day" (two lines, day by day), sort "oldest". The app lines up the same days of the month before.
- "this week vs last week": the same with week. "this year vs last year": timeFilter "this_year", comparison "same_period_last_n", comparisonGrain "year", comparisonOffset 1, dimension "month".
- "vs last year" / "year on year" for any question: comparison "same_period_last_n", comparisonGrain "year", comparisonOffset 1.
- A comparison split by a category (e.g. "by location this month vs last month") keeps the category as dimension.
- "trend", "over time", "monthly": dimension "month" (or the grain asked), sort "oldest".
- "top 5 X": dimension X, limit 5, sort "desc". "worst 3": limit -3, sort "asc".
- "share", "% of total", "mix": calculation "percent_of_total". "cumulative", "running total": "running_total". "growth month on month" without a period comparison: dimension "month" with "pct_diff_from_prev".
- Leave out what the question doesn't ask for.`;

function parseJSON(text: string): any {
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const start = cleaned.indexOf('{'); const end = cleaned.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('The AI did not return settings.');
    return JSON.parse(cleaned.slice(start, end + 1));
}

/** The file's values for a column (as a lookup), read on this computer. */
function valuesOf(dataset: Dataset, column: string): string[] {
    const seen = new Set<string>();
    const rows = dataset.rows || [];
    for (let i = 0; i < rows.length && i < 50000 && seen.size <= 2000; i++) {
        const v = rows[i]?.[column];
        if (v !== null && v !== undefined && v !== '') seen.add(String(v).trim());
    }
    return [...seen];
}

/** Match a word or phrase from the question to the file's values: exact first, then by its words. */
export function groundValue(values: string[], asked: string): string[] {
    const a = norm(asked);
    if (!a) return [];
    const exact = values.filter(v => norm(v) === a);
    if (exact.length) return exact;
    const singularAsked = a.split(' ').map(singular).join(' ');
    const sameWords = values.filter(v => norm(v).split(' ').map(singular).join(' ') === singularAsked);
    if (sameWords.length) return sameWords;
    const parts = singularAsked.split(' ').filter(w => w.length >= 3);
    if (!parts.length) return [];
    return values.filter(v => { const ws = new Set(norm(v).split(' ').map(singular)); return parts.every(p => ws.has(p)); });
}

const validPeriod = (grain: string, v: string) =>
    (grain === 'year' && /^\d{4}$/.test(v)) || (grain === 'quarter' && /^\d{4}-Q[1-4]$/.test(v))
    || (grain === 'month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)) || (grain === 'day' && /^\d{4}-\d{2}-\d{2}(__\d{4}-\d{2}-\d{2})?$/.test(v));

/** Check everything the AI returned against the file; keep what's valid, say what isn't. */
export function checkAISettings(dataset: Dataset, raw: any): { config: Record<string, any>; calculation: TableCalculation | null; notes: string[] } {
    const notes: string[] = [];
    const cols = new Map(dataset.columns.filter(c => !c.name.startsWith('__')).map(c => [c.name, c]));
    const isCol = (n: unknown) => typeof n === 'string' && cols.has(n);
    const groupable = (n: unknown) => isCol(n) && [ColumnType.DIMENSION, ColumnType.BOOLEAN, ColumnType.DATE, ColumnType.ID].includes(cols.get(n as string)!.type as ColumnType);
    const numeric = (n: unknown) => isCol(n) && cols.get(n as string)!.type === ColumnType.METRIC;
    const config: Record<string, any> = {};

    if (isCol(raw?.metric)) config.metric = raw.metric;
    else if (raw?.metric) notes.push(`There's no column called “${raw.metric}”.`);
    const agg = String(raw?.aggregation || '').toUpperCase();
    config.aggregation = AGGS.includes(agg) ? agg : 'SUM';
    if (config.metric && !numeric(config.metric) && ['SUM', 'AVG', 'MAX', 'MIN'].includes(config.aggregation)) config.aggregation = 'COUNT_DISTINCT';

    const dim = String(raw?.dimension ?? '');
    if ((GRAINS as readonly string[]).includes(dim) || groupable(dim)) config.dimension = dim;
    else if (dim) notes.push(`Couldn't split by “${words(dim)}”.`);
    else config.dimension = '';
    const sec = (Array.isArray(raw?.secondaryDimensions) ? raw.secondaryDimensions : []).filter((d: unknown) => groupable(d) && d !== config.dimension).slice(0, 2);
    if (sec.length) config.secondaryDimensions = sec;
    const secM = (Array.isArray(raw?.secondaryMetrics) ? raw.secondaryMetrics : []).filter((m: unknown) => numeric(m) && m !== config.metric).slice(0, 3);
    if (secM.length) { config.secondaryMetrics = secM; config.secondaryMetricVisuals = Object.fromEntries(secM.map((m: string) => [m, 'line'])); config.secondaryMetricAggregations = {}; config.axisMode = 'auto'; }

    const tf = String(raw?.timeFilter || 'all_time');
    config.timeFilter = TIME_PRESETS.includes(tf) || /^last_\d{1,3}_(days|weeks|months|years)$/.test(tf) ? tf : 'all_time';
    const dateColumn = primaryDateColumn(dataset);
    const dfs = (Array.isArray(raw?.dateFilters) ? raw.dateFilters : [])
        .map((d: any) => ({ grain: String(d?.grain || d?.timeGrain || ''), values: (Array.isArray(d?.values) ? d.values : []).map(String) }))
        .filter((d: any) => dateColumn && d.values.length && d.values.every((v: string) => validPeriod(d.grain, v)))
        .map((d: any) => ({ column: dateColumn!, timeGrain: d.grain, values: d.values }));
    if (dfs.length) config.dateFilters = dfs;

    const filters: Record<string, string[]> = {};
    const fromWords = (block: any, exclude: boolean) => {
        if (!block || typeof block !== 'object') return;
        for (const [col, asked] of Object.entries(block)) {
            if (!groupable(col) || cols.get(col)!.type === ColumnType.DATE) { notes.push(`Couldn't filter on “${words(col)}”.`); continue; }
            const values = valuesOf(dataset, col);
            const matched = new Set<string>();
            for (const a of (Array.isArray(asked) ? asked : [asked]).map(String)) {
                const hit = groundValue(values, a);
                if (hit.length) hit.forEach(h => matched.add(h));
                else notes.push(`“${a}” isn't a ${words(col)} in this file.`);
            }
            if (!matched.size) continue;
            filters[col] = exclude ? values.filter(v => !matched.has(v)) : [...matched];
        }
    };
    fromWords(raw?.filters, false);
    fromWords(raw?.exclude, true);
    if (Object.keys(filters).length) config.filters = filters;

    const sort = String(raw?.sort || '');
    if (['desc', 'asc', 'oldest', 'newest'].includes(sort)) config.sort = sort;
    else config.sort = (GRAINS as readonly string[]).includes(config.dimension) ? 'oldest' : 'desc';
    const limit = Math.trunc(Number(raw?.limit) || 0);
    if (limit && Math.abs(limit) <= 1000) config.limit = limit;

    const comparison = String(raw?.comparison || 'none');
    if (comparison === 'previous_period' || comparison === 'same_period_last_n') {
        if (!dateColumn) notes.push('This file has no dates to compare periods with.');
        else {
            config.comparison = comparison;
            const g = String(raw?.comparisonGrain || '');
            config.comparisonGrain = (GRAINS as readonly string[]).includes(g) ? g : (comparison === 'same_period_last_n' ? 'year' : 'month');
            const off = Math.trunc(Number(raw?.comparisonOffset) || 1);
            config.comparisonOffset = Math.min(5, Math.max(1, off));
        }
    }
    const calc = String(raw?.calculation || 'none') as TableCalculation;
    const calculation = CALCS.includes(calc) && config.dimension ? calc : null;
    return { config, calculation, notes };
}

const TIME_WORDS: Record<string, string> = {
    all_time: '', today: 'today', yesterday: 'yesterday', this_week: 'this week so far', this_month: 'this month so far', this_quarter: 'this quarter so far',
    this_year: 'this year so far', last_7_days: 'the last 7 days', last_30_days: 'the last 30 days', last_90_days: 'the last 90 days', last_year: 'last year',
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const periodWords = (grain: string, v: string) => {
    if (grain === 'month') return `${MONTHS[Number(v.slice(5, 7)) - 1]} ${v.slice(0, 4)}`;
    if (grain === 'quarter') return `${v.slice(5)} ${v.slice(0, 4)}`;
    if (v.includes('__')) return v.replace('__', ' to ');
    return v;
};

/** The settings as chips: what each tab was set to. */
export function describeSettings(config: Record<string, any>, calculation: TableCalculation | null): Understood[] {
    const out: Understood[] = [];
    const how: Record<string, string> = { SUM: 'total', AVG: 'average', COUNT: 'number of', COUNT_DISTINCT: 'number of different', MAX: 'highest', MIN: 'lowest' };
    if (config.metric) out.push({ slot: 'measure', text: `${how[config.aggregation] || ''} ${words(config.metric)}${config.secondaryMetrics?.length ? ` and ${config.secondaryMetrics.map(words).join(' and ')}` : ''}`.trim() });
    if (config.dimension) out.push({ slot: 'split', text: `by ${[config.dimension, ...(config.secondaryDimensions || [])].map(words).join(' and ')}` });
    const tf = config.timeFilter && config.timeFilter !== 'all_time' ? (TIME_WORDS[config.timeFilter] ?? words(config.timeFilter)) : '';
    if (tf) out.push({ slot: 'time', text: tf });
    for (const d of config.dateFilters || []) out.push({ slot: 'time', text: d.values.map((v: string) => periodWords(d.timeGrain, v)).join(', ') });
    for (const [col, vals] of Object.entries(config.filters || {})) {
        const list = vals as string[];
        out.push({ slot: 'filter', text: `${words(col)}: ${list.length > 3 ? `${list.slice(0, 2).join(', ')} +${list.length - 2} more` : list.join(', ')}` });
    }
    if (config.limit) out.push({ slot: 'top', text: config.limit > 0 ? `top ${config.limit}` : `bottom ${-config.limit}` });
    if (config.comparison === 'previous_period') out.push({ slot: 'compare', text: `next to the ${config.comparisonGrain || 'period'} before` });
    if (config.comparison === 'same_period_last_n') out.push({ slot: 'compare', text: `next to the same ${config.comparisonGrain === 'year' ? 'period' : config.comparisonGrain} ${config.comparisonOffset > 1 ? `${config.comparisonOffset} ${config.comparisonGrain}s` : `a ${config.comparisonGrain}`} earlier` });
    if (calculation) out.push({ slot: 'calc', text: CALC_WORDS[calculation] || words(calculation) });
    return out;
}

export type AskAI = (messages: Array<{ role: string; content: string }>) => Promise<string>;

const defaultAsk: AskAI = async (messages) => {
    const { data } = await fetchWithFallback(messages, { model: PLANNER_MODEL, temperature: 0, max_tokens: 700, timeout: 25000, effort: 'low' });
    return String(data?.choices?.[0]?.message?.content || '');
};

/** The question set up by the AI; read on this computer if the AI can't be reached or returns nothing usable. */
export async function planFromQuestion(dataset: Dataset, question: string, asOf?: string, ask: AskAI = defaultAsk): Promise<BuilderAnswerPlan> {
    const local = questionFromWords(dataset, question, asOf);
    const localPlan = (reason: string): BuilderAnswerPlan => ({
        config: local.config, calculation: null, understood: local.understood, source: 'local', fallbackReason: reason,
        notes: local.unused.length ? [`Not used: ${local.unused.map(w => `“${w}”`).join(', ')}.`] : [],
    });
    try {
        const meta = builderMetadata(dataset, asOf);
        const reply = await ask([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `File: ${JSON.stringify(meta)}\nQuestion: ${question}` },
        ]);
        const raw = parseJSON(reply);
        const { config, calculation, notes } = checkAISettings(dataset, raw);
        if (!config.metric) return localPlan('The AI could not pick a measure.');
        return {
            config, calculation, notes, source: 'ai',
            understood: describeSettings(config, calculation),
            reading: typeof raw.reading === 'string' ? raw.reading.slice(0, 240) : undefined,
        };
    } catch (error: any) {
        return localPlan(error?.message || 'The AI could not be reached.');
    }
}
