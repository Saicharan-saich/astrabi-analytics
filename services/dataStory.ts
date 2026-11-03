/**
 * Data story: what is actually worth knowing about a dataset, worked out in
 * the browser from every row. No AI call and nothing leaves the computer.
 *
 * Rather than a fixed template ("count", "total", "by the first column"), it
 * profiles the columns (skipping IDs, free text and years-as-numbers), tests
 * a set of findings and keeps the ones that say something:
 *
 *   overview       the size of the business in the file, and whether the
 *                  average is lifted by a few big rows
 *   trend          change on a year ago (or first half vs second), peak,
 *                  seasonality; a part-month at the end is left out
 *   anomaly        a period far from normal, and which group caused it
 *   movers         who grew and who fell in the latest periods
 *   breakdown      the groupings where the measure is most uneven
 *   concentration  how much the top 20% of products/customers bring
 *   margin         profit ÷ revenue by group, when both exist
 *   contrast       a different leader on a second measure
 *   relationship   two measures that move together (in bands)
 *   quality        gaps that change the numbers
 */
import { ColumnType, type Dataset, type FormattingConfig } from '../types';

export type StoryKind = 'overview' | 'trend' | 'anomaly' | 'movers' | 'breakdown' | 'concentration' | 'margin' | 'contrast' | 'relationship' | 'quality';

export interface StoryChart {
    data: Record<string, string | number>[];
    xKey: string;
    yKey: string;
    vis: 'bar' | 'horizontalBar' | 'line' | 'area' | 'doughnut';
    yLabel: string;
    numberFormat: FormattingConfig['numberFormat'];
}

export interface StoryKpi { label: string; value: string; note?: string }

export interface StoryFinding {
    id: string;
    kind: StoryKind;
    /** Short label above the headline: "Trend", "Who leads". */
    eyebrow: string;
    /** The finding itself, with the numbers in it. */
    headline: string;
    /** Supporting facts. */
    points: string[];
    chart?: StoryChart;
    kpis?: StoryKpi[];
    /** A question to explore it further in AI SQL. */
    ask?: string;
    score: number;
}

export interface DataStory {
    title: string;
    /** What the story covers: measure, rows, period, any filter. */
    subtitle: string;
    findings: StoryFinding[];
    rowCount: number;
    /** Filter taken from the request ("for 2024", "for North"). */
    scope?: string;
}

// ─── formatting ──────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SYMBOL: Record<string, string> = { GBP: '£', EUR: '€', USD: '$', INR: '₹', JPY: '¥' };
const NUMBER_FORMAT: Record<string, FormattingConfig['numberFormat']> = { GBP: 'currency_gbp', EUR: 'currency_eur', USD: 'currency_usd' };

const human = (name: string) => name.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
    // "engine size l" → "engine size (l)"
    .replace(/\s(l|kg|km|m|cm|mm|g|ml|lbs?|mph|kwh|gbp|usd|eur)$/, ' ($1)');
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const plural = (word: string) => /(s|x|ch|sh)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
const pluralPhrase = (phrase: string) => { const parts = phrase.split(' '); parts[parts.length - 1] = plural(parts[parts.length - 1]); return parts.join(' '); };
const pct = (value: number, digits = 0) => `${(value * 100).toFixed(Math.abs(value) < 0.1 && digits === 0 ? 1 : digits)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : '−'}${pct(Math.abs(value))}`;
const count = (value: number) => Math.round(value).toLocaleString('en-GB');

function compact(value: number, symbol = ''): string {
    const abs = Math.abs(value);
    const sign = value < 0 ? '−' : '';
    if (abs >= 1e9) return `${sign}${symbol}${(abs / 1e9).toFixed(2)}bn`;
    if (abs >= 1e6) return `${sign}${symbol}${(abs / 1e6).toFixed(abs >= 1e8 ? 0 : abs >= 1e7 ? 1 : 2)}m`;
    if (abs >= 1e4) return `${sign}${symbol}${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
    if (abs >= 100) return `${sign}${symbol}${Math.round(abs).toLocaleString('en-GB')}`;
    return `${sign}${symbol}${abs.toLocaleString('en-GB', { maximumFractionDigits: abs < 10 ? 2 : 1 })}`;
}
const round = (value: number) => Math.round(value * 100) / 100;

// ─── column profiling ────────────────────────────────────────────────────

const ID_NAME = /(^|[_\s-])(id|uuid|guid|key|code|ref|reference|number|no|num|nr|sku|barcode|ean|isbn)$|^(id|uuid|guid)([_\s-]|$)|_id_/i;
const FREE_TEXT = /(url|link|notes?|description|comment|comments|email|e-mail|phone|mobile|address|postcode|zip|remarks?|summary|message|text)$/i;
const NOT_A_MEASURE = /(^|_)(lat|lon|lng|latitude|longitude|zip|postcode|phone|year|yr|month|week|day|hour|quarter)$/i;
/** Per-row attributes (a car's price, a person's age): averaged, never added up. */
const PER_ROW = /(^|_)(unit|per|avg|average|mean|median)(_|$)|(rate|ratio|pct|percent|percentage|%|score|rating|age|temperature|temp|probability|nps|satisfaction|margin_pct|margin_percent|index|level|price|size|weight|height|length|width|mileage|miles|km|distance|duration|speed|capacity|engine|tenure|days|hours|minutes)/i;
/** Amounts that add up across rows. */
const ADDITIVE = /(revenue|sales|amount|quantity|qty|units|profit|cost|spend|value|total|count|income|turnover|orders|volume|gmv|fee|tax|earnings|budget|salary)/i;
const MONEY = /(revenue|sales|price|cost|amount|profit|spend|income|value|turnover|margin|fee|pay|salary|budget|gmv|earnings|total)/i;
const PROFIT = /(profit|margin|earnings|net_income|contribution)/i;
const REVENUE = /(revenue|sales|turnover|amount|income|gmv)/i;
const DATEISH = /^\d{4}-\d{2}(-\d{2})?/;

interface Measure { name: string; label: string; agg: 'sum' | 'avg'; symbol: string; numberFormat: FormattingConfig['numberFormat']; money: boolean }
interface Grouping { name: string; label: string; distinct: number; yearLike: boolean }
interface Period { key: string; label: string }

const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '' && /^-?[\d.,]+$/.test(value.trim())) { const n = Number(value.replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
    return null;
};
const asDay = (value: unknown): string | null => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    if (typeof value === 'string' && DATEISH.test(value)) return value.length >= 10 ? value.slice(0, 10) : `${value.slice(0, 7)}-01`;
    return null;
};

function profile(dataset: Dataset, rows: Record<string, any>[]) {
    const columns = dataset.columns.filter(column => !column.name.startsWith('__'));
    const fields = dataset.aiSqlSemanticModel?.fields || [];
    const semantic = (name: string) => fields.find(field => field.name === name);
    const sample = rows.length > 5000 ? rows.filter((_, index) => index % Math.ceil(rows.length / 5000) === 0) : rows;

    const measures: Measure[] = [];
    const groupings: Grouping[] = [];
    let idColumn: { name: string; distinct: number } | undefined;
    let dateColumn: string | undefined;

    for (const column of columns) {
        const values = sample.map(row => row[column.name]).filter(value => !isBlank(value));
        if (!values.length) continue;
        const field = semantic(column.name);
        const idByName = ID_NAME.test(column.name) || field?.semanticType === 'identifier';
        const distinctSample = new Set(values.map(String)).size;
        const numbers = values.map(asNumber).filter((n): n is number => n !== null);
        const yearLike = numbers.length === values.length && numbers.every(n => Number.isInteger(n) && n >= 1900 && n <= 2100) && distinctSample <= 150;

        if (column.type === ColumnType.DATE || (column.type !== ColumnType.METRIC && values.slice(0, 50).every(value => asDay(value)))) {
            if (!dateColumn && values.some(value => asDay(value))) dateColumn = column.name;
            continue;
        }
        if (idByName || (column.type !== ColumnType.METRIC && distinctSample / values.length > 0.9 && values.length > 40 && !yearLike)) {
            const distinct = new Set(rows.map(row => row[column.name]).filter(value => !isBlank(value)).map(String)).size;
            if (!idColumn || /order|invoice|transaction|sale|booking|ticket/i.test(column.name)) idColumn = { name: column.name, distinct };
            continue;
        }
        if (yearLike) {
            groupings.push({ name: column.name, label: human(column.name), distinct: new Set(rows.map(row => row[column.name]).filter(value => !isBlank(value)).map(String)).size, yearLike: true });
            continue;
        }
        if (column.type === ColumnType.METRIC && numbers.length >= values.length * 0.8) {
            if (NOT_A_MEASURE.test(column.name)) continue;
            const currency = (column as any).currency as string | undefined;
            const perRow = /(^|_)(unit|per|avg|average|mean|median)(_|$)/i.test(column.name);
            const avg = field?.additivity === 'non_additive' || field?.semanticType === 'percentage' || field?.semanticType === 'ratio'
                || perRow || (!ADDITIVE.test(column.name) && PER_ROW.test(column.name));
            measures.push({
                name: column.name, label: human(column.name), agg: avg ? 'avg' : 'sum',
                symbol: currency ? (SYMBOL[currency] || '') : '', numberFormat: (currency && NUMBER_FORMAT[currency]) || 'auto',
                money: Boolean(currency) || MONEY.test(column.name),
            });
            continue;
        }
        if (FREE_TEXT.test(column.name)) continue;
        const distinct = new Set(rows.map(row => row[column.name]).filter(value => !isBlank(value)).map(String)).size;
        if (distinct >= 2 && distinct <= Math.max(40, rows.length * 0.5)) groupings.push({ name: column.name, label: human(column.name), distinct, yearLike: false });
    }
    return { measures, groupings, idColumn, dateColumn };
}

const mentions = (question: string, name: string) => {
    const haystack = ` ${question.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const label = human(name).replace(/[^a-z0-9]+/g, ' ').trim();
    return label.length > 2 && (haystack.includes(` ${label} `) || haystack.includes(` ${plural(label)} `));
};

// ─── aggregation helpers ─────────────────────────────────────────────────

interface Group { key: string; value: number; rows: number }

function aggregate(rows: Record<string, any>[], by: (row: Record<string, any>) => string | null, measure: Measure): Group[] {
    const sums = new Map<string, { sum: number; n: number; rows: number }>();
    for (const row of rows) {
        const key = by(row);
        if (key === null) continue;
        const v = asNumber(row[measure.name]);
        const entry = sums.get(key) || { sum: 0, n: 0, rows: 0 };
        entry.rows++;
        if (v !== null) { entry.sum += v; entry.n++; }
        sums.set(key, entry);
    }
    return [...sums.entries()].map(([key, entry]) => ({ key, value: measure.agg === 'avg' ? (entry.n ? entry.sum / entry.n : 0) : entry.sum, rows: entry.rows }));
}

const groupKey = (name: string) => (row: Record<string, any>) => (isBlank(row[name]) ? null : String(row[name]).trim());
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function periodOf(day: string, grain: 'month' | 'quarter' | 'year'): Period {
    const y = day.slice(0, 4); const m = Number(day.slice(5, 7));
    if (grain === 'year') return { key: y, label: y };
    if (grain === 'quarter') { const q = Math.ceil(m / 3); return { key: `${y}-Q${q}`, label: `Q${q} ${y}` }; }
    return { key: `${y}-${String(m).padStart(2, '0')}-01`, label: `${MONTHS[m - 1]} ${y}` };
}
const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

/** Gini-style unevenness, 0 (even) to 1 (one group has everything). */
function unevenness(values: number[]): number {
    const v = values.filter(x => x > 0).sort((a, b) => a - b);
    const n = v.length; const total = v.reduce((s, x) => s + x, 0);
    if (n < 2 || !total) return 0;
    let cum = 0; v.forEach((x, i) => { cum += (i + 1) * x; });
    return Math.max(0, (2 * cum) / (n * total) - (n + 1) / n);
}

// ─── the story ───────────────────────────────────────────────────────────

export function buildDataStory(dataset: Dataset, question = ''): DataStory {
    const allRows = (dataset.rows || []) as Record<string, any>[];
    const name = dataset.name.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}[-_ ]/i, '').replace(/[_-]+/g, ' ');
    const { measures, groupings, idColumn, dateColumn } = profile(dataset, allRows);

    // ── scope from the request: a year, or a value of a grouping ──
    let rows = allRows;
    const scopes: string[] = [];
    const year = question.match(/\b(19|20)\d{2}\b/)?.[0];
    if (year && dateColumn) {
        const kept = rows.filter(row => asDay(row[dateColumn])?.startsWith(year));
        if (kept.length) { rows = kept; scopes.push(year); }
    }
    for (const grouping of groupings.filter(g => g.distinct <= 300 && !g.yearLike)) {
        const values = [...new Set(rows.map(row => row[grouping.name]).filter(value => typeof value === 'string' && value.trim().length >= 3).map(value => String(value).trim()))];
        const hit = values.find(value => new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(question));
        if (hit) { rows = rows.filter(row => String(row[grouping.name] ?? '').trim() === hit); scopes.push(hit); break; }
    }

    // ── what to measure ──
    const ranked = [...measures].sort((a, b) => {
        const score = (m: Measure) => (mentions(question, m.name) ? 100 : 0) + (m.symbol ? 20 : 0) + (REVENUE.test(m.name) ? 12 : 0) + (m.money ? 8 : 0) + (m.agg === 'sum' ? 5 : 0);
        return score(b) - score(a);
    });
    const measure = ranked[0];
    const fmt = (value: number, m: Measure | undefined = measure) => compact(value, m?.symbol || '');
    const recordWord = idColumn ? pluralPhrase(human(idColumn.name).replace(/\s*(id|number|no|num|ref|reference|code|key)$/i, '').trim() || 'record') : 'rows';
    const useful = groupings.filter(g => g.distinct >= 2 && rows.length / g.distinct >= 2);

    const findings: StoryFinding[] = [];
    const subtitleParts = [`${count(rows.length)} rows`];

    // ── dates ──
    const days = dateColumn ? rows.map(row => asDay(row[dateColumn])).filter((d): d is string => Boolean(d)).sort() : [];
    const firstDay = days[0]; const lastDay = days[days.length - 1];
    const spanMonths = firstDay && lastDay ? monthIndex(lastDay) - monthIndex(firstDay) + 1 : 0;
    const grain: 'month' | 'quarter' | 'year' = spanMonths > 120 ? 'year' : spanMonths > 36 ? 'quarter' : 'month';
    if (firstDay) subtitleParts.push(`${periodOf(firstDay, 'month').label} – ${periodOf(lastDay, 'month').label}`);

    // ── 1. overview ──
    if (measure) {
        const values = rows.map(row => asNumber(row[measure.name])).filter((n): n is number => n !== null);
        const total = values.reduce((s, v) => s + v, 0);
        const mean = values.length ? total / values.length : 0;
        const mid = values.length ? median(values) : 0;
        const kpis: StoryKpi[] = [];
        if (measure.agg === 'sum') kpis.push({ label: `Total ${measure.label}`, value: fmt(total) });
        else kpis.push({ label: `Average ${measure.label}`, value: fmt(mean) });
        if (idColumn && idColumn.distinct < rows.length * 0.98) {
            const distinct = new Set(rows.map(row => row[idColumn.name]).filter(v => !isBlank(v)).map(String)).size;
            kpis.push({ label: capital(recordWord), value: count(distinct), note: `${count(rows.length)} rows` });
        } else kpis.push({ label: capital(recordWord), value: count(rows.length) });
        if (measure.agg === 'sum') kpis.push({ label: `Typical ${measure.label}`, value: fmt(mid), note: `median; average ${fmt(mean)}` });
        if (measure.agg === 'avg') kpis.push({ label: `Middle ${measure.label}`, value: fmt(mid), note: `half are above, half below` });
        const second = ranked.find(m => m !== measure);
        if (second) {
            const list = rows.map(row => asNumber(row[second.name])).filter((n): n is number => n !== null);
            const sum = list.reduce((s, v) => s + v, 0);
            kpis.push(second.agg === 'sum' ? { label: `Total ${second.label}`, value: fmt(sum, second) } : { label: `Average ${second.label}`, value: fmt(list.length ? sum / list.length : 0, second) });
        }
        else if (firstDay) kpis.push({ label: 'Period', value: `${spanMonths} month${spanMonths === 1 ? '' : 's'}`, note: `${periodOf(firstDay, 'month').label} – ${periodOf(lastDay, 'month').label}` });

        const points: string[] = [];
        let headline = measure.agg === 'sum'
            ? `${fmt(total)} of ${measure.label} across ${count(rows.length)} ${recordWord === 'rows' ? 'rows' : recordWord}${firstDay ? `, ${periodOf(firstDay, 'month').label} to ${periodOf(lastDay, 'month').label}` : ''}.`
            : `The average ${measure.label} is ${fmt(mean)} across ${count(rows.length)} ${recordWord}${firstDay ? `, ${periodOf(firstDay, 'month').label} to ${periodOf(lastDay, 'month').label}` : ''}.`;
        if (measure.agg === 'avg') {
            points.push(`${capital(measure.label)} belongs to each row, so it is averaged rather than added up.`);
            if (mid > 0 && mean > mid * 1.3) points.push(`A few high values pull the average up: the middle ${measure.label} is ${fmt(mid)}.`);
        }
        if (measure.agg === 'sum' && mid > 0 && mean > mid * 1.5 && values.length >= 20) {
            const sorted = [...values].sort((a, b) => b - a);
            const topCount = Math.max(1, Math.round(values.length * 0.1));
            const topShare = sorted.slice(0, topCount).reduce((s, v) => s + v, 0) / total;
            points.push(`A few large rows lift the average: the typical row is ${fmt(mid)}, but the average is ${fmt(mean)}. The biggest 10% of rows make up ${pct(topShare)} of the total.`);
        } else if (measure.agg === 'sum' && values.length) {
            points.push(`The typical row is ${fmt(mid)}, close to the average of ${fmt(mean)}, so no small group of rows dominates.`);
        }
        const negatives = values.filter(v => v < 0);
        if (negatives.length && measure.agg === 'sum') points.push(`${count(negatives.length)} rows are negative (refunds or returns?), taking ${fmt(Math.abs(negatives.reduce((s, v) => s + v, 0)))} off the total.`);
        if (!firstDay && !useful.length) headline = headline.replace(/\.$/, '. There is no date or grouping column to break it down by.');
        findings.push({ id: 'overview', kind: 'overview', eyebrow: 'At a glance', headline, points, kpis, score: 1000 });
        subtitleParts.unshift(capital(measure.label));
    }

    // ── 2. trend ──
    let series: (Period & { value: number })[] = [];
    let partial: string | undefined;
    if (measure && dateColumn && spanMonths >= 3) {
        const byPeriod = new Map<string, { label: string; sum: number; n: number }>();
        for (const row of rows) {
            const day = asDay(row[dateColumn]); const v = asNumber(row[measure.name]);
            if (!day || v === null) continue;
            const p = periodOf(day, grain);
            const entry = byPeriod.get(p.key) || { label: p.label, sum: 0, n: 0 };
            entry.sum += v; entry.n++;
            byPeriod.set(p.key, entry);
        }
        series = [...byPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]))
            .map(([key, e]) => ({ key, label: e.label, value: measure.agg === 'avg' ? e.sum / e.n : e.sum }));
        // A last month that has only a few days in it would look like a collapse.
        if (grain === 'month' && lastDay && measure.agg === 'sum') {
            const daysIn = new Date(Number(lastDay.slice(0, 4)), Number(lastDay.slice(5, 7)), 0).getDate();
            if (Number(lastDay.slice(8, 10)) < daysIn * 0.8) partial = series[series.length - 1]?.label;
        }
        const complete = partial ? series.slice(0, -1) : series;
        if (complete.length >= 3) {
            const last = complete[complete.length - 1];
            const lag = grain === 'month' ? 12 : grain === 'quarter' ? 4 : 1;
            const yearAgo = complete.length > lag ? complete[complete.length - 1 - lag] : undefined;
            const half = Math.floor(complete.length / 2);
            const firstHalf = complete.slice(0, half).reduce((s, p) => s + p.value, 0) / half;
            const secondHalf = complete.slice(complete.length - half).reduce((s, p) => s + p.value, 0) / half;
            const peak = complete.reduce((best, p) => (p.value > best.value ? p : best), complete[0]);
            const low = complete.reduce((best, p) => (p.value < best.value ? p : best), complete[0]);
            const grainWord = grain === 'month' ? 'month' : grain === 'quarter' ? 'quarter' : 'year';
            let headline: string; let change: number;
            if (yearAgo && yearAgo.value && grain !== 'year') {
                change = (last.value - yearAgo.value) / Math.abs(yearAgo.value);
                headline = `${capital(measure.label)} is ${change >= 0 ? 'up' : 'down'} ${pct(Math.abs(change))} on a year ago: ${fmt(last.value)} in ${last.label}, against ${fmt(yearAgo.value)} in ${yearAgo.label}.`;
            } else {
                change = firstHalf ? (secondHalf - firstHalf) / Math.abs(firstHalf) : 0;
                headline = Math.abs(change) < 0.03
                    ? `${capital(measure.label)} has held steady: about ${fmt(secondHalf)} a ${grainWord} in the second half of the period, the same as the first.`
                    : `${capital(measure.label)} ${change > 0 ? 'grew' : 'fell'} ${pct(Math.abs(change))} from the first half of the period to the second (${fmt(firstHalf)} to ${fmt(secondHalf)} a ${grainWord}).`;
            }
            const points = [`Best ${grainWord}: ${peak.label} at ${fmt(peak.value)}. Weakest: ${low.label} at ${fmt(low.value)}.`];
            if (complete.length >= 6) {
                const recent = complete.slice(-3).reduce((s, p) => s + p.value, 0);
                const before = complete.slice(-6, -3).reduce((s, p) => s + p.value, 0);
                if (before) points.push(`The last three ${grainWord}s are ${signedPct((recent - before) / Math.abs(before))} on the three before.`);
            }
            // Seasonality: the same calendar months strong every year.
            if (grain === 'month' && complete.length >= 24) {
                const byCalendar = new Map<number, number[]>();
                for (const p of complete) { const m = Number(p.key.slice(5, 7)); byCalendar.set(m, [...(byCalendar.get(m) || []), p.value]); }
                const avgs = [...byCalendar.entries()].map(([m, list]) => ({ m, avg: list.reduce((s, v) => s + v, 0) / list.length }));
                const overall = avgs.reduce((s, a) => s + a.avg, 0) / avgs.length;
                const best = avgs.reduce((b, a) => (a.avg > b.avg ? a : b), avgs[0]);
                const worst = avgs.reduce((b, a) => (a.avg < b.avg ? a : b), avgs[0]);
                if (overall && best.avg > overall * 1.12) points.push(`There is a seasonal pattern: ${MONTHS[best.m - 1]} is usually the strongest month (${pct(best.avg / overall - 1)} above an average month), ${MONTHS[worst.m - 1]} the weakest.`);
            }
            if (partial) points.push(`${partial} is left out of the comparison: the data stops part-way through it.`);
            findings.push({
                id: 'trend', kind: 'trend', eyebrow: 'Trend', headline, points,
                chart: { data: series.map(p => ({ period: grain === 'month' ? p.key : p.label, [`${measure.name}`]: round(p.value) })), xKey: 'period', yKey: measure.name, vis: complete.length > 8 ? 'area' : 'bar', yLabel: `${capital(measure.label)} by ${grainWord}`, numberFormat: measure.numberFormat },
                ask: `Show ${measure.label} by ${grainWord}`,
                score: 90 + Math.min(30, Math.abs(change) * 60),
            });
        }
    }

    // ── 3. breakdowns: where the measure is most uneven ──
    const breakdownCandidates = measure ? useful.filter(g => g.distinct <= 30).map(grouping => {
        const groups = aggregate(rows, groupKey(grouping.name), measure).sort((a, b) => b.value - a.value);
        const values = groups.map(g => g.value);
        const total = values.reduce((s, v) => s + v, 0);
        const spread = measure.agg === 'avg'
            ? (Math.max(...values) - Math.min(...values)) / (Math.abs(median(values)) || 1)
            : unevenness(values);
        const sizeFit = grouping.distinct <= 12 ? 1 : grouping.distinct <= 20 ? 0.8 : 0.6;
        const asked = mentions(question, grouping.name) ? 60 : 0;
        return { grouping, groups, total, score: 50 + spread * 60 * sizeFit + asked - (grouping.yearLike ? 10 : 0) };
    }).filter(c => c.groups.length >= 2).sort((a, b) => b.score - a.score) : [];

    let evenSlide: StoryFinding | undefined;
    let breakdownsShown = 0;
    for (const candidate of breakdownCandidates.filter(c => !c.grouping.yearLike).slice(0, 4)) {
        if (breakdownsShown >= 2) break;
        const { grouping, groups, total } = candidate;
        const top = groups[0]; const second = groups[1]; const bottom = groups[groups.length - 1];
        const label = grouping.label;
        let headline: string;
        const points: string[] = [];
        if (measure.agg === 'avg' || total <= 0) {
            const gap = top.value && bottom.value ? (top.value - bottom.value) / Math.abs(bottom.value) : 1;
            headline = gap < 0.05
                ? `Average ${measure.label} barely changes by ${label}: every ${label} is between ${fmt(bottom.value)} and ${fmt(top.value)}.`
                : `${top.key} has the highest average ${measure.label} (${fmt(top.value)}), ${pct(gap)} above ${bottom.key} (${fmt(bottom.value)}).`;
            if (groups.length > 2) points.push(`The middle ${label} sits around ${fmt(median(groups.map(g => g.value)))}.`);
        } else {
            const share = top.value / total;
            const fair = 1 / groups.length;
            const third = groups[2]?.value || 0;
            if (groups.length >= 3 && top.value > second.value + third) headline = `${top.key} brings ${pct(share)} of ${measure.label} — more than the next two ${pluralPhrase(label)} combined.`;
            else if (share < fair * 1.25 && bottom.value > top.value * 0.75) headline = `${capital(measure.label)} is spread evenly across ${pluralPhrase(label)}: the smallest, ${bottom.key}, is within ${pct(1 - bottom.value / top.value)} of the largest, ${top.key}.`;
            else headline = `${top.key} leads on ${measure.label} with ${fmt(top.value)} (${pct(share)})${bottom.value > 0 ? `, ${(top.value / bottom.value).toFixed(1)}× ${bottom.key}` : ''}.`;
            const top3 = groups.slice(0, 3).map(g => `${g.key} ${pct(g.value / total)}`).join(', ');
            points.push(`Largest shares: ${top3}.`);
            let running = 0; let needed = 0;
            for (const g of groups) { running += g.value; needed++; if (running / total >= 0.8) break; }
            if (groups.length >= 4) points.push(`${needed} of ${groups.length} ${pluralPhrase(label)} make up 80% of the total.`);
            // Volume vs value: many rows but a small share, or the reverse.
            const rowTotal = groups.reduce((s, g) => s + g.rows, 0);
            const off = groups.map(g => ({ g, ratio: (g.value / total) / (g.rows / rowTotal) })).filter(x => x.g.rows / rowTotal >= 0.05).sort((a, b) => b.ratio - a.ratio);
            if (off.length >= 3 && off[0].ratio > 1.3) points.push(`${off[0].g.key} earns most per row: ${pct(off[0].g.value / total)} of ${measure.label} from ${pct(off[0].g.rows / rowTotal)} of rows.`);
            if (off.length >= 3 && off[off.length - 1].ratio < 0.75) { const low = off[off.length - 1]; points.push(`${low.g.key} has ${pct(low.g.rows / rowTotal)} of rows but only ${pct(low.g.value / total)} of ${measure.label}.`); }
        }
        // Two "it's even" slides say the same thing: fold the second into the first.
        const even = /spread evenly|barely changes/.test(headline);
        if (even && evenSlide) { evenSlide.points.push(`It is just as even by ${label} (${groups.length} ${pluralPhrase(label)}).`); continue; }
        const shown = groups.slice(0, 12);
        breakdownsShown++;
        findings.push({
            id: `breakdown_${grouping.name}`, kind: 'breakdown', eyebrow: `By ${label}`, headline, points,
            chart: {
                data: shown.map(g => ({ [grouping.name]: g.key, [measure.name]: round(g.value) })), xKey: grouping.name, yKey: measure.name,
                vis: measure.agg === 'sum' && total > 0 && groups.length <= 5 ? 'doughnut' : grouping.yearLike ? 'bar' : groups.length > 6 ? 'horizontalBar' : 'bar',
                yLabel: `${measure.agg === 'avg' ? 'Average' : 'Total'} ${measure.label} by ${label}`, numberFormat: measure.numberFormat,
            },
            ask: `Show ${measure.agg === 'avg' ? 'average' : 'total'} ${measure.label} by ${label}`,
            score: even ? Math.min(candidate.score, 55) : candidate.score,
        });
        if (even) evenSlide = findings[findings.length - 1];
    }
    // A year column with no real date gives the trend.
    if (measure && !findings.some(f => f.kind === 'trend')) {
        const yearGrouping = useful.find(g => g.yearLike && g.distinct >= 3);
        if (yearGrouping) {
            const groups = aggregate(rows, groupKey(yearGrouping.name), measure).sort((a, b) => a.key.localeCompare(b.key));
            const peak = groups.reduce((b, g) => (g.value > b.value ? g : b), groups[0]);
            const first = groups[0]; const last = groups[groups.length - 1];
            const third = Math.max(1, Math.floor(groups.length / 3));
            const early = groups.slice(0, third).reduce((s, g) => s + g.value, 0) / third;
            const late = groups.slice(-third).reduce((s, g) => s + g.value, 0) / third;
            const change = early ? (late - early) / Math.abs(early) : 0;
            const what = measure.agg === 'avg' ? `Average ${measure.label}` : capital(measure.label);
            findings.push({
                id: 'trend_year', kind: 'trend', eyebrow: `By ${yearGrouping.label}`,
                headline: Math.abs(change) < 0.05
                    ? `${what} hardly changes with ${yearGrouping.label}: about ${fmt(early)} for ${first.key}–${groups[third - 1].key} and ${fmt(late)} for ${groups[groups.length - third].key}–${last.key}.`
                    : `${what} ${change > 0 ? 'rises' : 'falls'} with ${yearGrouping.label}: from about ${fmt(early)} for ${first.key}–${groups[third - 1].key} to ${fmt(late)} for ${groups[groups.length - third].key}–${last.key} (${signedPct(change)}).`,
                points: [`Highest: ${peak.key} at ${fmt(peak.value)}. ${groups.length} years, ${first.key} to ${last.key}.`],
                chart: { data: groups.map(g => ({ [yearGrouping.name]: g.key, [measure.name]: round(g.value) })), xKey: yearGrouping.name, yKey: measure.name, vis: groups.length > 12 ? 'area' : 'bar', yLabel: `${capital(measure.label)} by ${yearGrouping.label}`, numberFormat: measure.numberFormat },
                ask: `Show ${measure.label} by ${yearGrouping.label}`,
                score: 70 + Math.min(40, Math.abs(change) * 80),
            });
            const index = findings.findIndex(f => f.id === `breakdown_${yearGrouping.name}`);
            if (index >= 0) findings.splice(index, 1);
        }
    }

    // ── 4. concentration: products, customers, models ──
    if (measure && measure.agg === 'sum') {
        const ENTITY = /product|customer|client|item|model|sku|brand|store|account|supplier|vendor|seller/i;
        const entityScore = (g: Grouping) => (mentions(question, g.name) ? 2 : 0) + (ENTITY.test(g.name) ? 1 : 0);
        const shown = new Set(findings.filter(f => f.kind === 'breakdown').map(f => f.chart?.xKey));
        const entity = useful.filter(g => !g.yearLike && g.distinct >= 10 && g.distinct <= rows.length / 2 && !(shown.has(g.name) && g.distinct <= 12))
            .sort((a, b) => entityScore(b) - entityScore(a))[0];
        if (entity) {
            const groups = aggregate(rows, groupKey(entity.name), measure).filter(g => g.value > 0).sort((a, b) => b.value - a.value);
            const total = groups.reduce((s, g) => s + g.value, 0);
            if (groups.length >= 10 && total > 0) {
                const k = Math.max(1, Math.round(groups.length * 0.2));
                const share = groups.slice(0, k).reduce((s, g) => s + g.value, 0) / total;
                const bottomHalf = groups.slice(Math.ceil(groups.length / 2)).reduce((s, g) => s + g.value, 0) / total;
                const words = pluralPhrase(entity.label);
                findings.push({
                    id: 'concentration', kind: 'concentration', eyebrow: `Top ${words}`,
                    headline: share >= 0.6
                        ? `${capital(measure.label)} is concentrated: the top ${k} of ${count(groups.length)} ${words} bring ${pct(share)} of it.`
                        : `${capital(measure.label)} is spread out: the top ${k} of ${count(groups.length)} ${words} bring ${pct(share)}, so no handful carries the business.`,
                    points: [
                        `Number one is ${groups[0].key} with ${fmt(groups[0].value)} (${pct(groups[0].value / total)}).`,
                        `The bottom half of ${words} bring ${pct(bottomHalf)} between them.`,
                    ],
                    chart: { data: groups.slice(0, 10).map(g => ({ [entity.name]: g.key, [measure.name]: round(g.value) })), xKey: entity.name, yKey: measure.name, vis: 'horizontalBar', yLabel: `Top 10 ${words} by ${measure.label}`, numberFormat: measure.numberFormat },
                    ask: `Top 10 ${words} by ${measure.label}`,
                    score: 60 + Math.abs(share - 0.4) * 60 + (mentions(question, entity.name) ? 40 : 0),
                });
            }
        }
    }

    // ── 5. movers: who grew and who fell recently ──
    const complete = partial ? series.slice(0, -1) : series;
    // Periods far from the ones around them (a one-off spike or dip).
    const unusual: { p: Period & { value: number }; i: number; z: number; baseline: number }[] = [];
    if (complete.length >= 8) {
        const values = complete.map(p => p.value);
        const baseline = values.map((_, i) => median([...values.slice(Math.max(0, i - 2), i), ...values.slice(i + 1, i + 3)]));
        const residuals = values.map((v, i) => v - baseline[i]);
        const mad = median(residuals.map(r => Math.abs(r - median(residuals)))) || 0;
        if (mad > 0) unusual.push(...complete.map((p, i) => ({ p, i, z: (0.6745 * residuals[i]) / mad, baseline: baseline[i] }))
            .filter(x => Math.abs(x.z) > 4 && Math.abs(x.p.value - x.baseline) / Math.abs(x.baseline || 1) > 0.15)
            .sort((a, b) => Math.abs(b.z) - Math.abs(a.z)));
    }
    const unusualKeys = new Set(unusual.map(u => u.p.key));
    if (measure && measure.agg === 'sum' && dateColumn && complete.length >= 4) {
        // A one-off spike would make everything after it look like a fall.
        const steady = complete.filter(p => !unusualKeys.has(p.key));
        const window = Math.min(grain === 'month' ? 3 : 1, Math.floor(steady.length / 2)) || 1;
        const recentKeys = new Set(steady.slice(-window).map(p => p.key));
        const beforeKeys = new Set(steady.slice(-2 * window, -window).map(p => p.key));
        const skipped = complete.slice(complete.indexOf(steady[Math.max(0, steady.length - 2 * window)])).filter(p => unusualKeys.has(p.key)).map(p => p.label);
        const windowLabel = (window === 1 ? `${steady[steady.length - 1].label} vs ${steady[steady.length - 2].label}` : `the last ${window} ${grain}s vs the ${window} before`)
            + (skipped.length ? ` (leaving out ${skipped.join(' and ')}, which was unusual)` : '');
        type Change = { key: string; change: number; before: number; off: number };
        let best: { grouping: Grouping; changes: Change[]; total: number; growth: number; reach: number } | undefined;
        for (const grouping of useful.filter(g => g.distinct <= 30 && !g.yearLike)) {
            const map = new Map<string, { recent: number; before: number }>();
            for (const row of rows) {
                const day = asDay(row[dateColumn]); const v = asNumber(row[measure.name]); const key = groupKey(grouping.name)(row);
                if (!day || v === null || key === null) continue;
                const p = periodOf(day, grain).key;
                const entry = map.get(key) || { recent: 0, before: 0 };
                if (recentKeys.has(p)) entry.recent += v; else if (beforeKeys.has(p)) entry.before += v; else continue;
                map.set(key, entry);
            }
            if (map.size < 2) continue;
            const beforeAll = [...map.values()].reduce((s, e) => s + e.before, 0);
            const total = [...map.values()].reduce((s, e) => s + e.recent - e.before, 0);
            const growth = beforeAll ? total / beforeAll : 0;
            // "off": how far a group is from moving in step with the whole.
            const changes = [...map.entries()].map(([key, e]) => ({ key, change: e.recent - e.before, before: e.before, off: e.recent - e.before * (1 + growth) }))
                .sort((a, b) => b.change - a.change);
            const reach = Math.max(...changes.map(c => Math.abs(c.off))) / Math.max(1, Math.abs(beforeAll));
            if (!best || reach > best.reach) best = { grouping, changes, total, growth, reach };
        }
        if (best && best.reach > 0.02) {
            const label = best.grouping.label;
            const rate = (c: Change) => (c.before ? ` (${signedPct(c.change / Math.abs(c.before))})` : '');
            const money = (v: number) => `${v >= 0 ? '+' : ''}${fmt(v)}`;
            const totalText = `${capital(measure.label)} is ${best.total >= 0 ? 'up' : 'down'} ${fmt(Math.abs(best.total))} (${signedPct(best.growth)}) in ${windowLabel}`;
            const odd = [...best.changes].sort((a, b) => Math.abs(b.off) - Math.abs(a.off))[0];
            const againstTrend = Math.sign(odd.change) !== Math.sign(best.total) && Math.abs(odd.change) > 0;
            const up = best.changes[0]; const down = best.changes[best.changes.length - 1];
            const headline = againstTrend
                ? `${totalText}, but ${label} ${odd.key} went the other way: ${money(odd.change)}${rate(odd)}.`
                : odd.change >= 0
                    ? `${totalText}, driven by ${label} ${odd.key}: ${money(odd.change)}${rate(odd)}.`
                    : `${totalText}, led by ${label} ${odd.key}: ${money(odd.change)}${rate(odd)}.`;
            const points: string[] = [];
            if (up.key !== odd.key && up.change > 0) points.push(`Biggest rise: ${up.key}, ${money(up.change)}${rate(up)}.`);
            if (down.key !== odd.key && down.change < 0) points.push(`Biggest fall: ${down.key}, ${money(down.change)}${rate(down)}.`);
            points.push(`Change by ${label}, ${windowLabel}.`);
            findings.push({
                id: 'movers', kind: 'movers', eyebrow: 'What changed', headline, points,
                chart: { data: best.changes.slice(0, 12).map(c => ({ [best!.grouping.name]: c.key, change: round(c.change) })), xKey: best.grouping.name, yKey: 'change', vis: 'horizontalBar', yLabel: `Change in ${measure.label}`, numberFormat: measure.numberFormat },
                ask: `Show ${measure.label} by ${grain} and ${label}`,
                score: 70 + Math.min(45, best.reach * 150) + (againstTrend ? 10 : 0),
            });
        }
    }

    // ── 6. anomaly: a period far from normal, and what drove it ──
    if (measure && unusual.length) {
        {
            const outliers = unusual;
            const hit = outliers[0];
            if (hit) {
                const mid = hit.baseline;
                const diff = hit.p.value - mid;
                const grainWord = grain === 'month' ? 'month' : grain === 'quarter' ? 'quarter' : 'year';
                const points = outliers.length > 1 ? [`Also unusual: ${outliers.slice(1, 3).map(o => o.p.label).join(' and ')}.`] : [];
                let chart: StoryChart | undefined;
                let driver: Grouping | undefined;
                let bestShare = 0;
                if (dateColumn && measure.agg === 'sum') for (const g of useful.filter(g => !g.yearLike && g.distinct <= 20)) {
                    const inHit = aggregate(rows.filter(row => { const d = asDay(row[dateColumn]); return d && periodOf(d, grain).key === hit.p.key; }), groupKey(g.name), measure);
                    const near = complete.filter((_, i) => i !== hit.i && Math.abs(i - hit.i) <= 2).map(p => p.key);
                    const nearRows = rows.filter(row => { const d = asDay(row[dateColumn]); return d && near.includes(periodOf(d, grain).key); });
                    const usual = new Map(aggregate(nearRows, groupKey(g.name), measure).map(x => [x.key, x.value / Math.max(1, near.length)]));
                    const top = inHit.map(x => x.value - (usual.get(x.key) || 0)).sort((a, b) => Math.abs(b) - Math.abs(a))[0] || 0;
                    const share = Math.sign(top) === Math.sign(diff) ? Math.abs(top) / Math.abs(diff) : 0;
                    if (share > bestShare) { bestShare = share; driver = g; }
                }
                if (driver && dateColumn && measure.agg === 'sum') {
                    // Each group in the odd period against its own typical period.
                    const perGroup = new Map<string, Map<string, number>>();
                    for (const row of rows) {
                        const day = asDay(row[dateColumn]); const v = asNumber(row[measure.name]); const key = groupKey(driver.name)(row);
                        if (!day || v === null || key === null) continue;
                        const p = periodOf(day, grain).key;
                        const m = perGroup.get(key) || new Map<string, number>();
                        m.set(p, (m.get(p) || 0) + v);
                        perGroup.set(key, m);
                    }
                    const near = complete.filter((_, i) => i !== hit.i && Math.abs(i - hit.i) <= 2).map(p => p.key);
                    const diffs = [...perGroup.entries()].map(([key, m]) => ({ key, diff: (m.get(hit.p.key) || 0) - median(near.map(k => m.get(k) || 0)) })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
                    if (diffs.length && Math.sign(diffs[0].diff) === Math.sign(diff)) {
                        points.unshift(`Most of the difference came from ${driver.label} ${diffs[0].key}: ${diffs[0].diff >= 0 ? '+' : ''}${fmt(diffs[0].diff)} against its own ${grainWord}s around it, ${Math.abs(diffs[0].diff) / Math.abs(diff) >= 0.95 ? 'essentially all of the gap' : `${pct(Math.abs(diffs[0].diff) / Math.abs(diff))} of the gap`}.`);
                        chart = { data: diffs.slice(0, 10).map(d => ({ [driver.name]: d.key, difference: round(d.diff) })), xKey: driver.name, yKey: 'difference', vis: 'horizontalBar', yLabel: `${hit.p.label} vs the ${grainWord}s around it`, numberFormat: measure.numberFormat };
                    }
                }
                findings.push({
                    id: 'anomaly', kind: 'anomaly', eyebrow: 'Stands out',
                    headline: `${hit.p.label} stands out: ${measure.label} was ${fmt(hit.p.value)}, ${pct(Math.abs(diff) / Math.abs(mid || 1))} ${diff > 0 ? 'above' : 'below'} the ${grainWord}s around it (about ${fmt(mid)}).`,
                    points, chart,
                    ask: driver ? `Show ${measure.label} by ${driver.label} for ${hit.p.label}` : undefined,
                    score: 80 + Math.min(30, Math.abs(hit.z) * 2),
                });
            }
        }
    }

    // ── 7. margin: profit ÷ revenue ──
    const profit = measures.find(m => m.agg === 'sum' && PROFIT.test(m.name));
    const revenue = measures.find(m => m.agg === 'sum' && m !== profit && REVENUE.test(m.name));
    if (profit && revenue) {
        const totalP = rows.reduce((s, row) => s + (asNumber(row[profit.name]) ?? 0), 0);
        const totalR = rows.reduce((s, row) => s + (asNumber(row[revenue.name]) ?? 0), 0);
        const grouping = breakdownCandidates.find(c => !c.grouping.yearLike)?.grouping || useful.find(g => g.distinct <= 30 && !g.yearLike);
        if (totalR > 0 && grouping) {
            const p = new Map(aggregate(rows, groupKey(grouping.name), profit).map(g => [g.key, g.value]));
            const margins = aggregate(rows, groupKey(grouping.name), revenue)
                .filter(g => g.value > totalR * 0.01)
                .map(g => ({ key: g.key, revenue: g.value, margin: (p.get(g.key) || 0) / g.value }))
                .sort((a, b) => b.margin - a.margin);
            if (margins.length >= 2) {
                const overall = totalP / totalR;
                const hi = margins[0]; const lo = margins[margins.length - 1];
                const biggest = [...margins].sort((a, b) => b.revenue - a.revenue)[0];
                const points = [`Overall, ${pct(overall, 1)} of ${revenue.label} is kept as ${profit.label}.`];
                if (biggest.margin < overall - 0.02) points.push(`${biggest.key} brings the most ${revenue.label} but keeps less of it (${pct(biggest.margin, 1)}).`);
                findings.push({
                    id: 'margin', kind: 'margin', eyebrow: 'Margin',
                    headline: `Margin ranges from ${pct(lo.margin, 1)} for ${lo.key} to ${pct(hi.margin, 1)} for ${hi.key}, against ${pct(overall, 1)} overall.`,
                    points,
                    chart: { data: margins.slice(0, 12).map(m => ({ [grouping.name]: m.key, margin_pct: Math.round(m.margin * 1000) / 10 })), xKey: grouping.name, yKey: 'margin_pct', vis: margins.length > 6 ? 'horizontalBar' : 'bar', yLabel: `Margin % (${profit.label} ÷ ${revenue.label})`, numberFormat: 'auto' },
                    ask: `Show ${profit.label} as a percentage of ${revenue.label} by ${grouping.label}`,
                    score: 75 + Math.min(25, (hi.margin - lo.margin) * 100),
                });
            }
        }
    }

    // ── 8. contrast: a different leader on another measure ──
    const lead = breakdownCandidates.find(c => !c.grouping.yearLike);
    if (measure && lead) {
        for (const other of ranked.filter(m => m !== measure && m !== profit).slice(0, 3)) {
            const groups = aggregate(rows, groupKey(lead.grouping.name), other).sort((a, b) => b.value - a.value);
            if (groups.length < 2 || groups[0].key === lead.groups[0].key) continue;
            // Only when the other measure really differs between groups.
            const leadValue = groups.find(g => g.key === lead.groups[0].key)?.value || 0;
            const low = groups[groups.length - 1].value;
            if (!groups[0].value || (groups[0].value - leadValue) / Math.abs(groups[0].value) < 0.08 || (low && (groups[0].value - low) / Math.abs(low) < 0.15)) continue;
            const word = other.agg === 'avg' ? `average ${other.label}` : other.label;
            findings.push({
                id: `contrast_${other.name}`, kind: 'contrast', eyebrow: `${capital(other.label)} tells another story`,
                headline: `${lead.groups[0].key} leads on ${measure.label}, but ${groups[0].key} leads on ${word} (${fmt(groups[0].value, other)}).`,
                points: [`${lead.groups[0].key} has ${fmt(groups.find(g => g.key === lead.groups[0].key)?.value || 0, other)} of ${word}.`],
                chart: { data: groups.slice(0, 12).map(g => ({ [lead.grouping.name]: g.key, [other.name]: round(g.value) })), xKey: lead.grouping.name, yKey: other.name, vis: groups.length > 6 ? 'horizontalBar' : 'bar', yLabel: `${capital(word)} by ${lead.grouping.label}`, numberFormat: other.numberFormat },
                ask: `Compare ${measure.label} and ${word} by ${lead.grouping.label}`,
                score: 68,
            });
            break;
        }
    }

    // ── 9. relationship: two measures that move together ──
    if (measures.length >= 2) {
        const sample = rows.length > 20000 ? rows.filter((_, i) => i % Math.ceil(rows.length / 20000) === 0) : rows;
        let strongest: { x: Measure; y: Measure; r: number } | undefined;
        const pool = ranked.slice(0, 5);
        const QUANTITY = /(quantity|qty|units|count|volume)/i;
        // Pairs where one is worked out from the other are not news.
        const mechanical = (a: Measure, b: Measure) => [[a, b], [b, a]].some(([x, y]) =>
            (PROFIT.test(x.name) && (REVENUE.test(y.name) || y.money))
            || (QUANTITY.test(x.name) && (REVENUE.test(y.name) || PROFIT.test(y.name))));
        for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
            if (mechanical(pool[i], pool[j])) continue;
            const pairs = sample.map(row => [asNumber(row[pool[i].name]), asNumber(row[pool[j].name])]).filter((p): p is [number, number] => p[0] !== null && p[1] !== null);
            if (pairs.length < 30) continue;
            const n = pairs.length; const mx = pairs.reduce((s, p) => s + p[0], 0) / n; const my = pairs.reduce((s, p) => s + p[1], 0) / n;
            let sxy = 0, sxx = 0, syy = 0;
            for (const [a, b] of pairs) { sxy += (a - mx) * (b - my); sxx += (a - mx) ** 2; syy += (b - my) ** 2; }
            const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
            // Nearly 1 means one is worked out from the other: not news.
            if (Math.abs(r) >= 0.45 && Math.abs(r) < 0.97 && (!strongest || Math.abs(r) > Math.abs(strongest.r))) {
                // Put the measure people care about (money first) on the y axis.
                const [x, y] = pool[i] === measure || (pool[i].money && !pool[j].money) ? [pool[j], pool[i]] : [pool[i], pool[j]];
                strongest = { x, y, r };
            }
        }
        if (strongest) {
            const { x, y, r } = strongest;
            const xs = sample.map(row => asNumber(row[x.name])).filter((v): v is number => v !== null).sort((a, b) => a - b);
            const distinctX = new Set(xs).size;
            const edges = [0.2, 0.4, 0.6, 0.8].map(q => xs[Math.floor(q * (xs.length - 1))]);
            const band = (v: number) => edges.findIndex(e => v <= e) === -1 ? 4 : edges.findIndex(e => v <= e);
            const sums = Array.from({ length: 5 }, () => ({ s: 0, n: 0 }));
            for (const row of sample) { const a = asNumber(row[x.name]); const b = asNumber(row[y.name]); if (a === null || b === null) continue; const k = band(a); sums[k].s += b; sums[k].n++; }
            const bounds = [xs[0], ...edges, xs[xs.length - 1]];
            let data = sums.map((s, k) => ({ band: `${compact(bounds[k], x.symbol)}–${compact(bounds[k + 1], x.symbol)}`, [`avg_${y.name}`]: round(s.n ? s.s / s.n : 0) })).filter((_, k) => sums[k].n > 0);
            if (distinctX <= 12) {
                // Few distinct values (1, 2, 3 …): one bar each.
                const exact = new Map<number, { s: number; n: number }>();
                for (const row of sample) { const a = asNumber(row[x.name]); const b = asNumber(row[y.name]); if (a === null || b === null) continue; const e = exact.get(a) || { s: 0, n: 0 }; e.s += b; e.n++; exact.set(a, e); }
                data = [...exact.entries()].sort((a, b) => a[0] - b[0]).map(([v, e]) => ({ band: compact(v, x.symbol), [`avg_${y.name}`]: round(e.s / e.n) }));
            }
            const firstAvg = Number(data[0]?.[`avg_${y.name}`]) || 0; const lastAvg = Number(data[data.length - 1]?.[`avg_${y.name}`]) || 0;
            findings.push({
                id: 'relationship', kind: 'relationship', eyebrow: 'Moves together',
                headline: distinctX <= 12
                    ? `Higher ${x.label} goes with ${r > 0 ? 'higher' : 'lower'} ${y.label}: on average ${fmt(firstAvg, y)} at ${x.label} ${data[0].band}, ${fmt(lastAvg, y)} at ${data[data.length - 1].band}.`
                    : `Higher ${x.label} goes with ${r > 0 ? 'higher' : 'lower'} ${y.label}: the lowest fifth by ${x.label} averages ${fmt(firstAvg, y)}, the highest fifth ${fmt(lastAvg, y)}.`,
                points: [`Correlation ${r.toFixed(2)} across ${count(sample.length)} rows${Math.abs(r) < 0.7 ? ' — a clear pattern, with plenty of exceptions' : ' — a strong pattern'}.`],
                chart: { data, xKey: 'band', yKey: `avg_${y.name}`, vis: 'bar', yLabel: `Average ${y.label} by ${x.label}${distinctX <= 12 ? '' : ' band'}`, numberFormat: y.numberFormat },
                ask: `Show average ${y.label} by ${x.label} band`,
                score: 60 + Math.abs(r) * 30,
            });
        }
    }

    // ── 10. quality: gaps that change the numbers ──
    const real = new Set(dataset.columns.map(c => c.name));
    const used = [measure?.name, dateColumn, ...findings.flatMap(f => f.chart ? [f.chart.xKey] : [])].filter((n): n is string => Boolean(n) && real.has(n as string));
    const gaps = [...new Set(used)].map(column => ({ column, blank: rows.filter(row => isBlank(row[column])).length })).filter(g => g.blank / Math.max(1, rows.length) >= 0.02).sort((a, b) => b.blank - a.blank);
    if (gaps.length) {
        findings.push({
            id: 'quality', kind: 'quality', eyebrow: 'Worth knowing',
            headline: `${count(gaps[0].blank)} rows (${pct(gaps[0].blank / rows.length)}) have no ${human(gaps[0].column)}, so they are left out wherever ${human(gaps[0].column)} is used.`,
            points: gaps.slice(1, 3).map(g => `${human(g.column)}: ${count(g.blank)} blank (${pct(g.blank / rows.length)}).`),
            score: 40,
        });
    }

    // Nothing varies: say so, it is the finding.
    const varies = findings.some(f => ['anomaly', 'movers', 'concentration', 'margin', 'contrast', 'relationship'].includes(f.kind)
        || (f.kind === 'breakdown' && f !== evenSlide)
        || (f.kind === 'trend' && !/hardly changes|held steady/.test(f.headline)));
    const overview = findings.find(f => f.kind === 'overview');
    if (overview && measure && evenSlide && !varies) {
        const names = [...new Set([...breakdownCandidates.map(c => c.grouping.label)])].slice(0, 4);
        overview.points.push(`${capital(measure.label)} is almost the same whichever way you split it (${names.join(', ')}): in this file it does not depend on any of them.`);
    }

    // ── choose and order ──
    const ORDER: StoryKind[] = ['overview', 'trend', 'anomaly', 'movers', 'breakdown', 'concentration', 'margin', 'contrast', 'relationship', 'quality'];
    const chosen = findings.filter(f => f.kind === 'overview' || f.kind === 'quality')
        .concat(findings.filter(f => f.kind !== 'overview' && f.kind !== 'quality').sort((a, b) => b.score - a.score).slice(0, 6));
    chosen.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || b.score - a.score);

    const scope = scopes.length ? scopes.join(', ') : undefined;
    return {
        title: scope ? `${capital(name)} — ${scope}` : capital(name),
        subtitle: subtitleParts.join(' · '),
        findings: chosen,
        rowCount: rows.length,
        scope,
    };
}
