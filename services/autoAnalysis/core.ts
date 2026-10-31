/**
 * Auto analysis — data preparation.
 *
 * Decides WHAT to analyse (the business metrics, the useful breakdowns, the
 * date and its grain) and prepares the rows once (period keys, parsed dates)
 * so every analyser works from the same, honest view of the data:
 *
 *  - Incomplete periods are detected and kept out of comparisons, so a month
 *    that has only 12 days of data never reads as a "big drop".
 *  - Ratios (margin, average order value, average rating) are carried as a
 *    numerator and a denominator, so they can be compared and decomposed
 *    correctly instead of summing or averaging averages.
 *
 * Pure TypeScript over the rows (no DuckDB), so it is deterministic, fast for
 * typical uploads and fully unit-testable.
 */

import type { Dataset } from '../../types';
import { buildSemanticModel, type SemanticModel, type SemanticMeasure } from '../semanticModel';

// ───────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────

export type MetricFormat = 'currency_usd' | 'currency_eur' | 'percent' | 'number';
export type Grain = 'month' | 'week' | 'day';

/**
 * A metric the analysis can compute for any group of rows.
 *  sum   — Σ column (additive)
 *  count — number of rows, or distinct values of `distinctColumn` (additive across disjoint groups)
 *  ratio — Σ numerator / denominator (margin, average order value, average rating)
 */
export interface MetricDef {
    id: string;
    label: string;
    kind: 'sum' | 'count' | 'ratio';
    column?: string;
    distinctColumn?: string;
    /** Ratio numerator: a column to sum. */
    numerator?: string;
    /** Ratio denominator: a column to sum, '__rows', '__nonnull:<col>' or '__distinct:<col>'. */
    denominator?: string;
    /** Ratio shown as a percentage (value × 100, shown in points). */
    asPercent?: boolean;
    format: MetricFormat;
    /** true = up is good, false = up is bad, null = neutral. */
    higherIsBetter: boolean | null;
}

export interface DimInfo {
    column: string;
    label: string;
    /** Distinct non-empty values. */
    cardinality: number;
}

/** The choices an analysis is built from; stored with each card so it can be recomputed. */
export interface Focus {
    dateColumn: string | null;
    grain: Grain | null;
    metrics: MetricDef[];
    dims: DimInfo[];
    /** Singular / plural noun for one row, e.g. order / orders. */
    noun: { one: string; many: string };
    /** Column that identifies the business entity (order_id), when there is one. */
    entityColumn: string | null;
}

export interface PeriodInfo {
    key: string;
    label: string;
    start: number;
    end: number; // exclusive
    /** Share of the period covered by the data range (0–1). */
    coverage: number;
}

export interface Prepared {
    rows: Record<string, any>[];
    focus: Focus;
    /** Period key per row ('' when the row has no usable date). */
    periodOfRow: string[];
    /** Parsed epoch-ms per row (NaN when missing). */
    timeOfRow: number[];
    /** All periods from first to last, in order (including empty ones). */
    periods: PeriodInfo[];
    /** Periods safe to compare (complete enough), in order. */
    complete: PeriodInfo[];
    /** Periods left out because they are only partly covered. */
    partial: PeriodInfo[];
    minTime: number;
    maxTime: number;
    undatedRows: number;
}

// ───────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const humanize = (col: string) => {
    const text = col.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text.charAt(0).toUpperCase() + text.slice(1);
};

export function toNumber(value: unknown): number {
    if (value === null || value === undefined || value === '') return NaN;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'boolean') return NaN;
    const cleaned = String(value).replace(/[,$€£\s"]/g, '').replace(/%$/, '');
    return cleaned === '' ? NaN : Number(cleaned);
}

/** Parse a date cell to epoch ms (UTC midnight for date-only values). */
export function parseDate(value: unknown): number {
    if (value === null || value === undefined || value === '') return NaN;
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') {
        if (value > 1e11) return value; // epoch ms
        if (value > 1e9) return value * 1000; // epoch s
        return NaN;
    }
    const text = String(value).trim();
    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
    const ym = text.match(/^(\d{4})-(\d{1,2})$/);
    if (ym) return Date.UTC(+ym[1], +ym[2] - 1, 1);
    const dmy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (dmy) {
        // Ambiguous d/m vs m/d: treat as day-first unless the first part can't be a day.
        const a = +dmy[1], b = +dmy[2];
        const [day, month] = b > 12 ? [b, a] : [a, b];
        return Date.UTC(+dmy[3], month - 1, day);
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : NaN;
}

function startOfPeriod(t: number, grain: Grain): number {
    const d = new Date(t);
    if (grain === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (grain === 'day') return day;
    const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
    return day - weekday * DAY;
}

function nextPeriod(start: number, grain: Grain): number {
    if (grain === 'month') {
        const d = new Date(start);
        return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
    return start + (grain === 'week' ? 7 : 1) * DAY;
}

function periodKey(start: number, grain: Grain): string {
    const d = new Date(start);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    if (grain === 'month') return `${y}-${m}`;
    return `${y}-${m}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function periodLabel(start: number, grain: Grain): string {
    const d = new Date(start);
    const month = MONTHS[d.getUTCMonth()];
    if (grain === 'month') return `${month} ${d.getUTCFullYear()}`;
    if (grain === 'week') return `w/c ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
    return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

export function grainNoun(grain: Grain | null): string {
    return grain === 'week' ? 'week' : grain === 'day' ? 'day' : 'month';
}

// ───────────────────────────────────────────────────────────────────
// Choosing the focus
// ───────────────────────────────────────────────────────────────────

const NAME_LIKE = /(^|_)(name|first_?name|last_?name|full_?name|address|email|phone|description|notes?|comment|url|title)($|_)/i;
const GOOD_DIM = /(category|segment|region|department|channel|type|status|group|class|tier|brand|market|country|state|city|division|source|platform|product|vendor|supplier|team|store|branch|plan|gender|payment|method|ward|condition|specialty|level|grade)/i;
const NON_ADDITIVE_NAME = /(^|_)(avg|average|mean|median|rate|ratio|pct|percent|percentage|score|rating|age|price|margin|discount|satisfaction|nps|tenure|duration|stay|days|years)($|_)/i;
const CURRENCY_NAME = /(revenue|sales|amount|price|cost|profit|income|spend|payment|billing|charge|fee|salary|wage|budget|expense|gmv|value|total)/i;
const REVENUE_NAME = /(^|_)(revenue|sales|turnover|gmv|net_?sales|gross_?sales|amount|billing)($|_)/i;
const PROFIT_NAME = /(^|_)(profit|margin_?amount|gross_?profit|net_?profit|earnings)($|_)/i;
const COST_NAME = /(^|_)(cost|expense|spend|refund|loss|debt|churn|defect|complaint|return)/i;

function measureFormat(m: SemanticMeasure): MetricFormat {
    if (m.format === 'currency_usd') return 'currency_usd';
    if (m.format === 'currency_eur') return 'currency_eur';
    if (m.format === 'percent') return 'percent';
    return CURRENCY_NAME.test(m.column) && !/(qty|quantity|units|count)/i.test(m.column) ? 'currency_usd' : 'number';
}

function direction(column: string): boolean | null {
    if (COST_NAME.test(column)) return false;
    if (REVENUE_NAME.test(column) || PROFIT_NAME.test(column) || /(quantity|qty|units|orders|bookings|admissions|visits|satisfaction|rating|score)/i.test(column)) return true;
    return null;
}

function isAdditiveMeasure(m: SemanticMeasure): boolean {
    if (m.format === 'percent') return false;
    if (NON_ADDITIVE_NAME.test(m.column) && !/(total|amount|sales|revenue)/i.test(m.column)) return false;
    if (m.behavior === 'non_additive') return false;
    const agg = String(m.aggregation || '').toUpperCase();
    return agg === 'SUM' || agg === '' || m.behavior === 'additive';
}

function pluralize(word: string): string {
    if (/s$/i.test(word)) return word;
    if (/y$/i.test(word) && !/[aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
    return `${word}s`;
}

/** Plain-English metric label: "revenue" → "Revenue", "total_sales" → "Total sales". */
function metricLabel(column: string): string {
    return humanize(column);
}

function resolveModel(dataset: Dataset): SemanticModel | null {
    if (dataset.semanticModel?.measures) return dataset.semanticModel;
    try {
        return buildSemanticModel(dataset);
    } catch {
        return null;
    }
}

/**
 * Decide what to analyse. Deterministic: the same dataset always gives the
 * same focus, so a rebuilt dashboard has the same cards.
 */
export function chooseFocus(dataset: Dataset): Focus {
    const rows = dataset.rows || [];
    const model = resolveModel(dataset);
    const columns = dataset.columns || [];
    const sample = rows.length > 5000 ? rows.filter((_, i) => i % Math.ceil(rows.length / 5000) === 0) : rows;

    // ── Entity (what one business record is) ──
    const idColumns = columns.filter(c => c.type === 'ID').map(c => c.name);
    const entityColumn = idColumns.find(name => {
        const distinct = new Set(sample.map(r => r?.[name]).filter(v => v !== null && v !== undefined && v !== '')).size;
        return distinct >= Math.max(5, sample.length * 0.2);
    }) || null;
    const grainWord = (dataset.domainProfile as any)?.grain as string | undefined;
    const nounBase = entityColumn
        ? humanize(entityColumn.replace(/(_|\s)?(id|key|no|number|num|code)$/i, '')).toLowerCase() || 'record'
        : grainWord ? grainWord.toLowerCase() : 'record';
    const noun = { one: nounBase, many: pluralize(nounBase) };

    // ── Metrics ──
    const measures = (model?.measures || []).filter(m => !m.isHidden && !/(^|_)(id|key|code|zip|postal|phone|year|month|day|week|lat|lon|latitude|longitude)($|_)/i.test(m.column));
    const numericOk = (column: string) => {
        let numeric = 0, present = 0;
        for (const r of sample) {
            const v = r?.[column];
            if (v === null || v === undefined || v === '') continue;
            present++;
            if (Number.isFinite(toNumber(v))) numeric++;
        }
        return present > 0 && numeric / present >= 0.9;
    };
    const usable = measures.filter(m => numericOk(m.column));
    const score = (m: SemanticMeasure) => (REVENUE_NAME.test(m.column) ? 30 : 0) + (PROFIT_NAME.test(m.column) ? 12 : 0)
        + (measureFormat(m).startsWith('currency') ? 10 : 0) + (/(quantity|qty|units)/i.test(m.column) ? 6 : 0);
    const additive = usable.filter(isAdditiveMeasure).sort((a, b) => score(b) - score(a));
    const nonAdditive = usable.filter(m => !isAdditiveMeasure(m));

    const metrics: MetricDef[] = [];
    const primary = additive[0];
    if (primary) {
        metrics.push({ id: `sum:${primary.column}`, label: metricLabel(primary.column), kind: 'sum', column: primary.column, format: measureFormat(primary), higherIsBetter: direction(primary.column) ?? true });
    }
    // Count of business records (orders, admissions…) — always available.
    metrics.push(entityColumn
        ? { id: `count:${entityColumn}`, label: humanize(noun.many), kind: 'count', distinctColumn: entityColumn, format: 'number', higherIsBetter: true }
        : { id: 'count:__rows', label: humanize(noun.many), kind: 'count', format: 'number', higherIsBetter: true });
    // Average value per record (average order value) for a currency primary.
    if (primary && measureFormat(primary).startsWith('currency')) {
        metrics.push({
            id: `ratio:${primary.column}/per`, label: `Average ${metricLabel(primary.column).toLowerCase()} per ${noun.one}`,
            kind: 'ratio', numerator: primary.column, denominator: entityColumn ? `__distinct:${entityColumn}` : '__rows',
            format: measureFormat(primary), higherIsBetter: true,
        });
    }
    // Margin when there is profit and revenue.
    const profit = additive.find(m => PROFIT_NAME.test(m.column));
    const revenue = additive.find(m => REVENUE_NAME.test(m.column) && m !== profit);
    if (profit && revenue) {
        metrics.push({ id: `ratio:${profit.column}/${revenue.column}`, label: `${metricLabel(profit.column)} margin`, kind: 'ratio', numerator: profit.column, denominator: revenue.column, asPercent: true, format: 'percent', higherIsBetter: true });
    }
    // A second additive measure (profit, quantity…).
    const secondary = additive.find(m => m !== primary);
    if (secondary) {
        metrics.push({ id: `sum:${secondary.column}`, label: metricLabel(secondary.column), kind: 'sum', column: secondary.column, format: measureFormat(secondary), higherIsBetter: direction(secondary.column) ?? true });
    }
    // One average-type measure (rating, age, discount…).
    const avgMeasure = nonAdditive[0];
    if (avgMeasure) {
        const isPct = avgMeasure.format === 'percent';
        metrics.push({
            id: `ratio:${avgMeasure.column}/avg`, label: `Average ${metricLabel(avgMeasure.column).toLowerCase()}`, kind: 'ratio',
            numerator: avgMeasure.column, denominator: `__nonnull:${avgMeasure.column}`, format: isPct ? 'percent' : measureFormat(avgMeasure),
            higherIsBetter: direction(avgMeasure.column),
        });
    }

    // ── Breakdowns ──
    const dimCandidates = (model?.dimensions || [])
        .filter(d => d.dataType === 'string' && !d.isHidden && !NAME_LIKE.test(d.column) && !idColumns.includes(d.column));
    const dims: DimInfo[] = [];
    for (const d of dimCandidates) {
        const values = new Set<string>();
        for (const r of sample) {
            const v = r?.[d.column];
            if (v === null || v === undefined || String(v).trim() === '') continue;
            values.add(String(v));
            if (values.size > 60) break;
        }
        if (values.size < 2 || values.size > 60) continue;
        if (values.size > sample.length * 0.5) continue; // near-unique: not a grouping
        dims.push({ column: d.column, label: humanize(d.column), cardinality: values.size });
    }
    dims.sort((a, b) => {
        const good = (d: DimInfo) => (GOOD_DIM.test(d.column) ? 2 : 0) + (d.cardinality >= 3 && d.cardinality <= 20 ? 1 : 0);
        return good(b) - good(a) || a.cardinality - b.cardinality;
    });

    // ── Date and grain ──
    const dateColumn = model?.primaryDateColumn
        || columns.find(c => c.type === 'DATE')?.name
        || null;
    let grain: Grain | null = null;
    if (dateColumn) {
        const times: number[] = [];
        for (const r of rows) {
            const t = parseDate(r?.[dateColumn]);
            if (Number.isFinite(t)) times.push(t);
        }
        grain = chooseGrain(times);
    }

    return { dateColumn: grain ? dateColumn : null, grain, metrics, dims: dims.slice(0, 5), noun, entityColumn };
}

/**
 * The finest grain whose periods are reasonably full. Sparse data (a few rows
 * a month) is analysed by month even over a short span, so a "latest week"
 * is never an empty bucket.
 */
export function chooseGrain(times: number[]): Grain | null {
    if (times.length < 4) return null;
    let min = Infinity, max = -Infinity;
    for (const t of times) { if (t < min) min = t; if (t > max) max = t; }
    const spanDays = (max - min) / DAY;
    const fill = (grain: Grain) => {
        const used = new Set<number>();
        for (const t of times) used.add(startOfPeriod(t, grain));
        let total = 0;
        for (let s = startOfPeriod(min, grain); s <= max && total < 5000; s = nextPeriod(s, grain)) total++;
        return { periods: total, filled: used.size / Math.max(1, total), perPeriod: times.length / Math.max(1, total) };
    };
    const candidates: Grain[] = spanDays >= 120 ? ['month'] : spanDays >= 28 ? ['week', 'month'] : spanDays >= 6 ? ['day', 'week'] : [];
    for (const grain of candidates) {
        const f = fill(grain);
        if (f.periods >= 3 && f.filled >= 0.8 && f.perPeriod >= 3) return grain;
    }
    // Fall back to months when there are at least a few of them.
    const months = fill('month');
    return months.periods >= 3 ? 'month' : null;
}

// ───────────────────────────────────────────────────────────────────
// Preparing rows
// ───────────────────────────────────────────────────────────────────

/** Bucket rows by period and work out which periods are complete enough to compare. */
export function prepare(rows: Record<string, any>[], focus: Focus): Prepared {
    const periodOfRow: string[] = new Array(rows.length).fill('');
    const timeOfRow: number[] = new Array(rows.length).fill(NaN);
    let minTime = Infinity, maxTime = -Infinity, undatedRows = 0;
    const { dateColumn, grain } = focus;

    if (dateColumn && grain) {
        for (let i = 0; i < rows.length; i++) {
            const t = parseDate(rows[i]?.[dateColumn]);
            if (!Number.isFinite(t)) { undatedRows++; continue; }
            timeOfRow[i] = t;
            periodOfRow[i] = periodKey(startOfPeriod(t, grain), grain);
            if (t < minTime) minTime = t;
            if (t > maxTime) maxTime = t;
        }
    }

    const periods: PeriodInfo[] = [];
    if (grain && Number.isFinite(minTime)) {
        const dataStart = Date.UTC(new Date(minTime).getUTCFullYear(), new Date(minTime).getUTCMonth(), new Date(minTime).getUTCDate());
        const dataEnd = Date.UTC(new Date(maxTime).getUTCFullYear(), new Date(maxTime).getUTCMonth(), new Date(maxTime).getUTCDate()) + DAY;
        for (let start = startOfPeriod(minTime, grain); start <= maxTime && periods.length < 2000; start = nextPeriod(start, grain)) {
            const end = nextPeriod(start, grain);
            const covered = Math.min(end, dataEnd) - Math.max(start, dataStart);
            periods.push({ key: periodKey(start, grain), label: periodLabel(start, grain), start, end, coverage: Math.max(0, covered) / (end - start) });
        }
    }
    // A period is comparable when the data range covers (almost) all of it.
    // Monthly data that stops on the 28th of a 31-day month still counts.
    const threshold = grain === 'month' ? 0.85 : grain === 'week' ? 0.99 : 1;
    const complete = periods.filter(p => p.coverage >= threshold - 1e-9);
    const partial = periods.filter(p => p.coverage < threshold - 1e-9);

    return { rows, focus, periodOfRow, timeOfRow, periods, complete, partial, minTime, maxTime, undatedRows };
}

// ───────────────────────────────────────────────────────────────────
// Aggregation
// ───────────────────────────────────────────────────────────────────

export interface Acc { num: number; den: number; ids?: Set<string>; denIds?: Set<string>; rows: number }

export function newAcc(metric: MetricDef): Acc {
    const acc: Acc = { num: 0, den: 0, rows: 0 };
    if (metric.kind === 'count' && metric.distinctColumn) acc.ids = new Set();
    if (metric.kind === 'ratio' && metric.denominator?.startsWith('__distinct:')) acc.denIds = new Set();
    return acc;
}

export function addRow(acc: Acc, metric: MetricDef, row: Record<string, any>): void {
    acc.rows++;
    if (metric.kind === 'sum') {
        const v = toNumber(row?.[metric.column!]);
        if (Number.isFinite(v)) acc.num += v;
        return;
    }
    if (metric.kind === 'count') {
        if (acc.ids) {
            const id = row?.[metric.distinctColumn!];
            if (id !== null && id !== undefined && id !== '') acc.ids.add(String(id));
        } else acc.num += 1;
        return;
    }
    const n = toNumber(row?.[metric.numerator!]);
    const den = metric.denominator || '__rows';
    if (den === '__rows') {
        if (Number.isFinite(n)) acc.num += n;
        acc.den += 1;
    } else if (den.startsWith('__nonnull:')) {
        if (Number.isFinite(n)) { acc.num += n; acc.den += 1; }
    } else if (den.startsWith('__distinct:')) {
        if (Number.isFinite(n)) acc.num += n;
        const id = row?.[den.slice('__distinct:'.length)];
        if (id !== null && id !== undefined && id !== '') acc.denIds!.add(String(id));
    } else {
        const d = toNumber(row?.[den]);
        if (Number.isFinite(n) && Number.isFinite(d)) { acc.num += n; acc.den += d; }
    }
}

/** Numerator and denominator after aggregation (denominator 1 for additive metrics). */
export function parts(acc: Acc, metric: MetricDef): { num: number; den: number } {
    if (metric.kind === 'sum') return { num: acc.num, den: 1 };
    if (metric.kind === 'count') return { num: acc.ids ? acc.ids.size : acc.num, den: 1 };
    return { num: acc.num, den: acc.denIds ? acc.denIds.size : acc.den };
}

export function valueOf(acc: Acc | undefined, metric: MetricDef): number {
    if (!acc) return metric.kind === 'ratio' ? NaN : 0;
    const { num, den } = parts(acc, metric);
    if (metric.kind !== 'ratio') return num;
    if (!(den > 0)) return NaN;
    return metric.asPercent ? (num / den) * 100 : num / den;
}

export const isAdditive = (metric: MetricDef) => metric.kind !== 'ratio';

/**
 * Aggregate a metric by a key function. Rows for which key() returns null are
 * skipped. Returns a Map keyed by group.
 */
export function groupBy(
    prep: Prepared,
    metric: MetricDef,
    key: (rowIndex: number) => string | null,
    rowFilter?: (rowIndex: number) => boolean,
): Map<string, Acc> {
    const out = new Map<string, Acc>();
    const { rows } = prep;
    for (let i = 0; i < rows.length; i++) {
        if (rowFilter && !rowFilter(i)) continue;
        const k = key(i);
        if (k === null) continue;
        let acc = out.get(k);
        if (!acc) { acc = newAcc(metric); out.set(k, acc); }
        addRow(acc, metric, rows[i]);
    }
    return out;
}

export function dimValue(row: Record<string, any>, column: string): string | null {
    const v = row?.[column];
    if (v === null || v === undefined) return null;
    const text = String(v).trim();
    return text === '' ? null : text;
}

// ───────────────────────────────────────────────────────────────────
// Formatting for headlines
// ───────────────────────────────────────────────────────────────────

function compact(value: number, digits = 1): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '−' : '';
    if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(digits)}B`;
    if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(digits)}M`;
    if (abs >= 1e4) return `${sign}${(abs / 1e3).toFixed(digits)}K`;
    if (abs >= 100) return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
    if (abs >= 10) return `${sign}${abs.toFixed(abs % 1 === 0 ? 0 : 1)}`;
    return `${sign}${abs.toFixed(abs === 0 || abs % 1 === 0 ? 0 : 2)}`;
}

export function fmt(value: number, metric: MetricDef): string {
    if (!Number.isFinite(value)) return '—';
    if (metric.format === 'percent') {
        const v = metric.asPercent ? value : value; // ratios already in points when asPercent
        return `${v.toFixed(Math.abs(v) < 10 ? 1 : 1)}%`;
    }
    const symbol = metric.format === 'currency_usd' ? '$' : metric.format === 'currency_eur' ? '€' : '';
    const text = compact(value);
    return text.startsWith('−') ? `−${symbol}${text.slice(1)}` : `${symbol}${text}`;
}

/** Signed change in the metric's units: "+$2.3K", "−140", "+1.2 pts". */
export function fmtDelta(delta: number, metric: MetricDef): string {
    if (!Number.isFinite(delta)) return '—';
    const sign = delta >= 0 ? '+' : '−';
    if (metric.format === 'percent') return `${sign}${Math.abs(delta).toFixed(1)} pts`;
    const text = fmt(Math.abs(delta), metric);
    return `${sign}${text}`;
}

/** Relative change "+12%" / "−3.4%"; empty when the base is zero. */
export function fmtPct(change: number): string {
    if (!Number.isFinite(change)) return '';
    const pct = change * 100;
    const digits = Math.abs(pct) < 10 ? 1 : 0;
    return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(digits)}%`;
}

export const lower = (text: string) => (/^[A-Z]{2,}/.test(text) ? text : text.charAt(0).toLowerCase() + text.slice(1));
