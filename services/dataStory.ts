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
import { averageCaution } from '../utils/averageCheck';
import { localDateKey } from '../utils/dateKey';
import { flagSubject, isYesNoColumn, yesNoLabel } from './ai-sql/plainLabels';
import { describeDatasetShape } from './datasetShape';
import { isPerRowName } from '../utils/numberMeaning';
import { buildRecordsStory } from './recordsStory';
import { findPlanActual } from '../utils/planActual';

export type StoryKind = 'overview' | 'plan' | 'trend' | 'anomaly' | 'movers' | 'breakdown' | 'concentration' | 'margin' | 'contrast' | 'relationship' | 'quality';

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
const MONEY = /(revenue|sales|price|cost|amount|profit|spend|income|value|turnover|margin|fee|pay|salary|budget|gmv|earnings|total)/i;
const PROFIT = /(profit|margin|earnings|net_income|contribution)/i;
const REVENUE = /(revenue|sales|turnover|amount|income|gmv)/i;
const DATEISH = /^\d{4}-\d{2}(-\d{2})?/;

interface Measure { name: string; label: string; agg: 'sum' | 'avg'; symbol: string; numberFormat: FormattingConfig['numberFormat']; money: boolean }
interface Grouping { name: string; label: string; distinct: number; yearLike: boolean; yesNo?: boolean }
interface Period { key: string; label: string }

const isBlank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
const asNumber = (value: unknown): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '' && /^-?[\d.,]+$/.test(value.trim())) { const n = Number(value.replace(/,/g, '')); return Number.isFinite(n) ? n : null; }
    return null;
};
const asDay = (value: unknown): string | null => {
    if (value instanceof Date) return localDateKey(value);
    if (typeof value === 'string' && DATEISH.test(value)) return value.length >= 10 ? value.slice(0, 10) : `${value.slice(0, 7)}-01`;
    return null;
};

function profile(dataset: Dataset, rows: Record<string, any>[]) {
    // Numbers that describe each row (age, days waited) are not groupings.
    const shape = describeDatasetShape(dataset);
    const perRow = new Set(shape.countStory ? shape.perRowNumbers : []);
    const columns = dataset.columns.filter(column => !column.name.startsWith('__') && !(perRow.has(column.name) && column.type !== ColumnType.METRIC));
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
        // A yes/no column (holiday flag, is_member): a grouping of two, read as words.
        if (isYesNoColumn(values, column.name) && distinctSample <= 2 && !idByName) {
            groupings.push({ name: column.name, label: flagSubject(column.name), distinct: distinctSample, yearLike: false, yesNo: true });
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
                || perRow || isPerRowName(column.name);
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
    // Yes/no columns as words everywhere below ("Holiday" / "Not holiday"), and
    // numbered groups with their name ("Store 45", not "45", which reads as an amount).
    const yesNo = groupings.filter(g => g.yesNo).map(g => g.name);
    const numbered = groupings.filter(g => !g.yesNo && !g.yearLike && allRows.slice(0, 200).every(row => isBlank(row[g.name]) || /^-?\d+$/.test(String(row[g.name]).trim()))).map(g => g.name);
    const groupWord = (name: string) => { const w = human(name).replace(/\s*(id|no|number|code|key)$/i, '').trim() || human(name); return w.charAt(0).toUpperCase() + w.slice(1); };
    let rows = yesNo.length || numbered.length
        ? allRows.map(row => {
            const copy = { ...row };
            for (const name of yesNo) if (!isBlank(row[name])) copy[name] = yesNoLabel(name, row[name]);
            for (const name of numbered) if (!isBlank(row[name])) copy[name] = `${groupWord(name)} ${String(row[name]).trim()}`;
            return copy;
        })
        : allRows;
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

    // ── records with nothing to add up: count them and compare outcomes ──
    const shape = describeDatasetShape(dataset);
    if (shape.countStory) {
        const story = buildRecordsStory(rows, dataset, shape, question);
        const scope = scopes.length ? scopes.join(', ') : undefined;
        return {
            title: scope ? `${capital(name)} — ${scope}` : capital(name),
            subtitle: [story.lead, `${count(rows.length)} rows`, ...story.subtitle].join(' · '),
            findings: story.findings.filter(f => f.kind === 'overview').concat(story.findings.filter(f => f.kind !== 'overview').sort((a, b) => b.score - a.score).slice(0, 7)),
            rowCount: rows.length,
            scope,
        };
    }

    // ── what to measure ──
    const ranked = [...measures].sort((a, b) => {
        const score = (m: Measure) => (mentions(question, m.name) ? 100 : 0) + (m.symbol ? 20 : 0) + (REVENUE.test(m.name) ? 12 : 0) + (m.money ? 8 : 0) + (m.agg === 'sum' ? 5 : 0);
        return score(b) - score(a);
    });
    // A file that sets actuals against a plan is about the actuals: "budgeted amount is down 2%" is not the story.
    const planActual = findPlanActual(measures.map(m => m.name), shape.formulas || []);
    const actualMeasure = planActual && !measures.some(m => mentions(question, m.name)) ? measures.find(m => m.name === planActual.actual) : undefined;
    const measure = actualMeasure || ranked[0];
    const fmt = (value: number, m: Measure | undefined = measure) => compact(value, m?.symbol || '');
    const recordWord = idColumn ? pluralPhrase(human(idColumn.name).replace(/\s*(id|number|no|num|ref|reference|code|key)$/i, '').trim() || 'record') : 'rows';
    const oneRecord = recordWord === 'rows' ? 'row' : recordWord.replace(/ies$/, 'y').replace(/(ch|sh|x|s)es$/, '$1').replace(/s$/, '');
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
        if (measure.agg === 'sum') kpis.push({ label: `Typical ${oneRecord}`, value: fmt(mid), note: `middle value; average ${fmt(mean)}` });
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
        if (rows.length < 30) points.push(`There are only ${count(rows.length)} rows, so treat every pattern here as a rough guide: one row more or less can change it.`);
        if (measure.agg === 'avg') points.push(`${capital(measure.label)} belongs to each row, so it is averaged rather than added up.`);
        // An average that hides very uneven values (100, 0, 0, 0 → 25).
        const caution = values.length >= 3 ? averageCaution(values, oneRecord) : null;
        if (caution) {
            const listed = values.length <= 6 ? ` The ${count(values.length)} values are ${[...values].sort((a, b) => b - a).map(v => fmt(v)).join(', ')}.` : '';
            points.push(`Don't read the average as typical: ${caution.reason}.${listed} The typical ${oneRecord} is ${fmt(mid)}, against an average of ${fmt(mean)}.`);
        } else if (measure.agg === 'avg') {
            if (mid > 0 && mean > mid * 1.3) points.push(`A few high values pull the average up: the middle ${measure.label} is ${fmt(mid)}.`);
        } else if (mid > 0 && mean > mid * 1.5 && values.length >= 20) {
            const sorted = [...values].sort((a, b) => b - a);
            const topCount = Math.max(1, Math.round(values.length * 0.1));
            const topShare = sorted.slice(0, topCount).reduce((s, v) => s + v, 0) / total;
            points.push(`A few large ${recordWord} lift the average: the typical ${oneRecord} is ${fmt(mid)}, but the average is ${fmt(mean)}. The biggest 10% of ${recordWord} make up ${pct(topShare)} of the total.`);
        } else if (values.length && mean && Math.abs(mean - mid) / Math.abs(mean) < 0.25) {
            points.push(`The typical ${oneRecord} is ${fmt(mid)}, close to the average of ${fmt(mean)}, so no small group of ${recordWord} dominates.`);
        }
        const negatives = values.filter(v => v < 0);
        if (negatives.length && measure.agg === 'sum') points.push(`${count(negatives.length)} rows are negative (refunds or returns?), taking ${fmt(Math.abs(negatives.reduce((s, v) => s + v, 0)))} off the total.`);
        if (!firstDay && !useful.length) headline = headline.replace(/\.$/, '. There is no date or grouping column to break it down by.');
        findings.push({ id: 'overview', kind: 'overview', eyebrow: 'At a glance', headline, points, kpis, score: 1000 });
        subtitleParts.unshift(capital(measure.label));
    }

    // ── 1b. against the plan: who is over and who is under ──
    // Worked out row by row, so a row with a budget and no actual (or the reverse) is left out of both sides.
    if (planActual) {
        const both = rows.map(row => ({ row, plan: asNumber(row[planActual.plan]), actual: asNumber(row[planActual.actual]) }))
            .filter((r): r is { row: Record<string, any>; plan: number; actual: number } => r.plan !== null && r.actual !== null);
        const totalPlan = both.reduce((s, r) => s + r.plan, 0);
        const totalActual = both.reduce((s, r) => s + r.actual, 0);
        if (both.length >= 2 && totalPlan !== 0) {
            const w = planActual.planWord;
            const [more, less] = planActual.nature === 'income' ? ['ahead of', 'short of'] : planActual.nature === 'spending' ? ['over', 'under'] : ['above', 'below'];
            const side = (gap: number) => gap > 0 ? more : less;
            const share = (gap: number, plan: number, open = ' (', close = ')') => plan ? `${open}${pct(Math.abs(gap) / Math.abs(plan), 1)} of ${w}${close}` : '';
            const gap = totalActual - totalPlan;
            const planM = measures.find(m => m.name === planActual.plan);
            const points: string[] = [];
            const skipped = rows.length - both.length;
            if (skipped > 0) points.push(`${count(skipped)} row${skipped === 1 ? ' is' : 's are'} missing the ${human(planActual.plan)} or the ${human(planActual.actual)}, and ${skipped === 1 ? 'is' : 'are'} left out of this comparison.`);
            // The grouping people ask about first: the first useful one that is not just a label for the same thing ("Over Budget").
            const restates = (g: Grouping) => rows.slice(0, 300).some(row => /\b(over|under|on|above|below|within)\b.*\b(budget|target|plan|forecast)\b/i.test(String(row[g.name] ?? '')));
            const grouping = useful.find(g => g.distinct <= 40 && !g.yearLike && !restates(g));
            let chart: StoryChart | undefined;
            let ask: string | undefined;
            if (grouping) {
                const by = new Map<string, { plan: number; actual: number }>();
                for (const r of both) {
                    const key = isBlank(r.row[grouping.name]) ? 'Not recorded' : String(r.row[grouping.name]);
                    const entry = by.get(key) || { plan: 0, actual: 0 };
                    entry.plan += r.plan; entry.actual += r.actual;
                    by.set(key, entry);
                }
                const gaps = [...by.entries()].map(([name, e]) => ({ name, gap: e.actual - e.plan, plan: e.plan })).sort((a, b) => b.gap - a.gap);
                const bad = planActual.nature === 'income' ? [...gaps].reverse().filter(g => g.gap < 0) : gaps.filter(g => g.gap > 0);
                const good = planActual.nature === 'income' ? gaps.filter(g => g.gap > 0) : [...gaps].reverse().filter(g => g.gap < 0);
                const say = (g: { name: string; gap: number; plan: number }) => `${g.name} (${fmt(Math.abs(g.gap))} ${side(g.gap)}${share(g.gap, g.plan, ', ', '')})`;
                const badWord = planActual.nature === 'income' ? less : more;
                const goodWord = planActual.nature === 'income' ? more : less;
                points.unshift(bad.length
                    ? `${count(bad.length)} of ${count(gaps.length)} ${pluralPhrase(grouping.label)} ${bad.length === 1 ? 'is' : 'are'} ${badWord} ${w}. Furthest: ${bad.slice(0, 3).map(say).join(', ')}.`
                    : `No ${grouping.label} is ${badWord} ${w}.`);
                if (good.length) points.splice(1, 0, `Furthest ${goodWord} ${w}: ${good.slice(0, 3).map(say).join(', ')}.`);
                const label = planActual.nature === 'income' ? `${human(planActual.actual)} against ${w}` : `${more} ${w}`;
                chart = { data: gaps.slice(0, 15).map(g => ({ [grouping.name]: g.name, [label]: Math.round(g.gap * 100) / 100 })), xKey: grouping.name, yKey: label, vis: 'horizontalBar', yLabel: capital(label), numberFormat: measure?.numberFormat || 'auto' };
                ask = planActual.nature === 'income' ? `Which ${pluralPhrase(grouping.label)} are short of ${w}?` : `Which ${pluralPhrase(grouping.label)} are over ${w}?`;
            }
            const verb = planActual.nature === 'spending' ? 'Spent' : capital(human(planActual.actual));
            findings.push({
                id: 'plan', kind: 'plan', eyebrow: `Against ${w}`,
                headline: `${verb}${planActual.nature === 'spending' ? '' : ' came to'} ${fmt(totalActual)} against a ${w} of ${fmt(totalPlan, planM)}: ${Math.abs(gap) < 0.005 ? `exactly on ${w}` : `${fmt(Math.abs(gap))} ${side(gap)}${share(gap, totalPlan)}`}.`,
                points, chart, ask, score: 990,
            });
        }
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
        // A month with no rows is a month of 0 sales, not a month that did not happen.
        if (grain === 'month' && measure.agg === 'sum' && series.length >= 2) {
            const have = new Map(series.map(p => [p.key, p]));
            const filled: typeof series = [];
            const start = monthIndex(series[0].key), end = monthIndex(series[series.length - 1].key);
            for (let i = start; i <= end; i++) {
                const y = Math.floor(i / 12), m = (i % 12) + 1;
                const key = `${y}-${String(m).padStart(2, '0')}-01`;
                filled.push(have.get(key) || { key, label: `${MONTHS[m - 1]} ${y}`, value: 0 });
            }
            series = filled;
        }
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
        let top = groups[0]; const second = groups[1]; let bottom = groups[groups.length - 1];
        const label = grouping.label;
        let headline: string;
        const points: string[] = [];
        if (grouping.yesNo) {
            // Totals by a yes/no say little (most weeks are not holidays): compare the average row.
            const avgs = aggregate(rows, groupKey(grouping.name), { ...measure, agg: 'avg' }).sort((a, b) => b.value - a.value);
            if (avgs.length < 2 || !avgs[1].value) continue;
            const gap = (avgs[0].value - avgs[1].value) / Math.abs(avgs[1].value);
            const yes = avgs.find(g => g.key === yesNoLabel(grouping.name, true)) || avgs[0];
            const no = avgs.find(g => g !== yes) || avgs[1];
            const yesGap = (yes.value - no.value) / Math.abs(no.value || 1);
            headline = Math.abs(gap) < 0.03
                ? `${capital(measure.label)} is about the same with or without ${label}: ${fmt(yes.value)} vs ${fmt(no.value)} on average.`
                : `${capital(label)} rows average ${fmt(yes.value)} of ${measure.label}, ${pct(Math.abs(yesGap))} ${yesGap > 0 ? 'more' : 'less'} than other rows (${fmt(no.value)}).`;
            points.push(`${count(yes.rows)} rows are ${label} and ${count(no.rows)} are not, so totals mostly reflect how many there are; the average per row is the fair comparison.`);
            breakdownsShown++;
            findings.push({
                id: `breakdown_${grouping.name}`, kind: 'breakdown', eyebrow: `${capital(label)} or not`, headline, points,
                chart: { data: [yes, no].map(g => ({ [grouping.name]: g.key, [`avg_${measure.name}`]: round(g.value) })), xKey: grouping.name, yKey: `avg_${measure.name}`, vis: 'bar', yLabel: `Average ${measure.label} per row`, numberFormat: measure.numberFormat },
                ask: `Compare average ${measure.label} with and without ${label}`,
                score: 60 + Math.min(40, Math.abs(yesGap) * 200),
            });
            continue;
        }
        if (measure.agg === 'avg' || total <= 0) {
            // A group with one or two rows can top an average by chance.
            const solid = groups.filter(g => g.rows >= 3);
            const thin = groups.filter(g => g.rows < 3);
            if (solid.length >= 2 && thin.length) {
                top = solid[0]; bottom = solid[solid.length - 1];
                points.push(`${thin.slice(0, 3).map(g => g.key).join(', ')}${thin.length > 3 ? ` and ${thin.length - 3} more` : ''} ${thin.length === 1 ? 'has' : 'have'} fewer than 3 rows, so ${thin.length === 1 ? 'its average is' : 'their averages are'} left out of the comparison.`);
            }
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
        for (const grouping of useful.filter(g => g.distinct <= 30 && !g.yearLike && !g.yesNo)) {
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
                if (dateColumn && measure.agg === 'sum') for (const g of useful.filter(g => !g.yearLike && !g.yesNo && g.distinct <= 20)) {
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
        const grouping = breakdownCandidates.find(c => !c.grouping.yearLike && !c.grouping.yesNo)?.grouping || useful.find(g => g.distinct <= 30 && !g.yearLike && !g.yesNo);
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
                    chart: { data: margins.slice(0, 12).map(m => ({ [grouping.name]: m.key, margin_pct: Math.round(m.margin * 1000) / 10 })), xKey: grouping.name, yKey: 'margin_pct', vis: margins.length > 6 ? 'horizontalBar' : 'bar', yLabel: `Margin % (${profit.label} ÷ ${revenue.label})`, numberFormat: 'percent_points' },
                    ask: `Show ${profit.label} as a percentage of ${revenue.label} by ${grouping.label}`,
                    score: 75 + Math.min(25, (hi.margin - lo.margin) * 100),
                });
            }
        }
    }

    // ── 8. contrast: a different leader on another measure ──
    const lead = breakdownCandidates.find(c => !c.grouping.yearLike && !c.grouping.yesNo);
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
    const ORDER: StoryKind[] = ['overview', 'plan', 'trend', 'anomaly', 'movers', 'breakdown', 'concentration', 'margin', 'contrast', 'relationship', 'quality'];
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

// ─── a deeper look: "tell me more", "what else" ──────────────────────────

export interface DeeperLook {
    title: string;
    /** What was looked into this time, in one or two sentences. */
    summary: string;
    findings: StoryFinding[];
    rowCount: number;
    /** Nothing new is left to say at this depth. */
    exhausted: boolean;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FINDINGS_PER_LOOK = 4;

/**
 * Investigations the overview does not make: what drove a change, where
 * combinations break the usual pattern, how averaged measures differ, what
 * moves together, weekday rhythm, value per record, and which groups swing.
 * Each call goes one level deeper and leaves out anything already said.
 * Worked out from every row on this computer; nothing is sent.
 */
export function buildDeeperLook(dataset: Dataset, depth = 1, alreadySaid: string[] = []): DeeperLook {
    const rows = (dataset.rows || []) as Record<string, any>[];
    const name = capital(dataset.name.replace(/\.[^.]+$/, '').replace(/^[0-9a-f]{8}[-_ ]/i, '').replace(/[_-]+/g, ' '));
    const { measures, groupings, idColumn, dateColumn } = profile(dataset, rows);
    const ranked = [...measures].sort((a, b) => {
        const score = (m: Measure) => (m.symbol ? 20 : 0) + (REVENUE.test(m.name) ? 12 : 0) + (m.money ? 8 : 0) + (m.agg === 'sum' ? 5 : 0);
        return score(b) - score(a);
    });
    const countMeasure: Measure = { name: '__rows', label: 'rows', agg: 'sum', symbol: '', numberFormat: 'auto', money: false };
    const main = ranked.find(m => m.agg === 'sum') || countMeasure;
    const val = (m: Measure, row: Record<string, any>) => (m.name === '__rows' ? 1 : asNumber(row[m.name]));
    const fmt = (v: number, m: Measure = main) => (m.name === '__rows' ? count(v) : compact(v, m.symbol));
    const signed = (v: number, m: Measure = main) => `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), m)}`;
    const sumBy = (subset: Record<string, any>[], key: (row: Record<string, any>) => string | null, m: Measure = main) => {
        const out = new Map<string, number>();
        for (const row of subset) { const k = key(row); const v = val(m, row); if (k === null || v === null) continue; out.set(k, (out.get(k) || 0) + v); }
        return out;
    };
    const total = (subset: Record<string, any>[], m: Measure = main) => subset.reduce((s, row) => s + (val(m, row) ?? 0), 0);
    const useful = groupings.filter(g => !g.yearLike && g.distinct >= 2 && g.distinct <= 30 && rows.length / g.distinct >= 3);
    const findings: StoryFinding[] = [];
    const bar = (data: { group: string; value: number }[], yLabel: string, m: Measure = main): StoryChart =>
        ({ data, xKey: 'group', yKey: 'value', vis: data.length > 6 ? 'horizontalBar' : 'bar', yLabel, numberFormat: m.numberFormat });

    // ── dates ──
    const dayOf = (row: Record<string, any>) => (dateColumn ? asDay(row[dateColumn]) : null);
    const months = dateColumn ? [...new Set(rows.map(dayOf).filter((d): d is string => Boolean(d)).map(d => d.slice(0, 7)))].sort() : [];

    /** Which grouping explains a change between two sets of rows best, and how. */
    const explainChange = (before: Record<string, any>[], after: Record<string, any>[], window: string, id: string, score: number) => {
        const change = total(after) - total(before);
        if (!before.length || !after.length || Math.abs(change) < Math.abs(total(before)) * 0.03) return;
        let best: { g: Grouping; deltas: { key: string; delta: number }[]; share: number } | undefined;
        for (const g of useful) {
            const a = sumBy(before, groupKey(g.name)); const b = sumBy(after, groupKey(g.name));
            const deltas = [...new Set([...a.keys(), ...b.keys()])].map(key => ({ key, delta: (b.get(key) || 0) - (a.get(key) || 0) }))
                .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
            const moved = deltas.reduce((s, d) => s + Math.abs(d.delta), 0);
            // The group that explains it must have moved the same way as the total.
            if (!moved || deltas.length < 2 || Math.sign(deltas[0].delta) !== Math.sign(change)) continue;
            const share = Math.abs(deltas[0].delta) / moved;
            if (!best || share > best.share) best = { g, deltas, share };
        }
        if (!best) return;
        const [first, second] = best.deltas;
        const against = best.deltas.find(d => Math.sign(d.delta) !== Math.sign(change) && Math.abs(d.delta) >= Math.abs(change) * 0.1);
        const up = change >= 0;
        findings.push({
            id, kind: 'movers', eyebrow: 'Why it changed',
            headline: `${capital(main.label)} is ${up ? 'up' : 'down'} ${fmt(Math.abs(change))} ${window}, and ${best.g.label} explains most of it: ${first.key} ${signed(first.delta)}${second ? `, ${second.key} ${signed(second.delta)}` : ''}.`,
            points: [
                Math.abs(first.delta) > Math.abs(change)
                    ? `${first.key} moved by more than the whole change (${signed(first.delta)}), because other groups went the other way.`
                    : `${first.key} alone accounts for ${pct(Math.abs(first.delta) / Math.abs(change))} of the ${up ? 'rise' : 'fall'}.`,
                ...(against ? [`${against.key} went the other way (${signed(against.delta)}), so without it the ${up ? 'rise' : 'fall'} would have been ${up ? 'bigger' : 'smaller'}.`] : []),
                `Of the ways to split the data, ${best.g.label} is the one where a single group explains the most of the change.`,
            ],
            chart: bar(best.deltas.slice(0, 10).map(d => ({ group: d.key, value: round(d.delta) })), `Change in ${main.label}`),
            ask: `Why did ${main.label} change by ${best.g.label}?`,
            score,
        });
    };
    if (months.length >= 6) {
        const last3 = new Set(months.slice(-3)); const prev3 = new Set(months.slice(-6, -3));
        const inSet = (set: Set<string>) => rows.filter(row => { const d = dayOf(row); return d !== null && set.has(d.slice(0, 7)); });
        const label = `in ${periodOf(`${months[months.length - 3]}-01`, 'month').label}–${periodOf(`${months[months.length - 1]}-01`, 'month').label} against the 3 months before`;
        explainChange(inSet(prev3), inSet(last3), label, 'deeper_recent', 92);
    }
    if (months.length >= 15) {
        const last3 = months.slice(-3);
        const yearAgo = new Set(last3.map(m => `${Number(m.slice(0, 4)) - 1}${m.slice(4)}`));
        if ([...yearAgo].every(m => months.includes(m))) {
            const now = rows.filter(row => { const d = dayOf(row); return d !== null && last3.includes(d.slice(0, 7)); });
            const then = rows.filter(row => { const d = dayOf(row); return d !== null && yearAgo.has(d.slice(0, 7)); });
            explainChange(then, now, 'on the same 3 months a year earlier', 'deeper_yoy', 88);
        }
    }

    // ── combinations that break the usual pattern ──
    const pairs = useful.filter(g => g.distinct <= 12);
    let hotspot: { a: Grouping; b: Grouping; cells: { key: string; actual: number; expected: number }[] } | undefined;
    let hotspotGap = 0;
    const grand = total(rows);
    if (grand > 0) for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
        const a = pairs[i]; const b = pairs[j];
        // One inside the other (menu item within menu category): most pairs can
        // never happen, so "below prediction" would mean nothing.
        const nested = (outer: Grouping, inner: Grouping) => {
            const seen = new Map<string, Set<string>>();
            for (const row of rows) {
                if (isBlank(row[outer.name]) || isBlank(row[inner.name])) continue;
                const k = String(row[inner.name]).trim(); const set = seen.get(k) || new Set<string>(); set.add(String(row[outer.name]).trim()); seen.set(k, set);
            }
            return [...seen.values()].filter(set => set.size === 1).length >= seen.size * 0.9;
        };
        if (nested(a, b) || nested(b, a)) continue;
        const byA = sumBy(rows, groupKey(a.name)); const byB = sumBy(rows, groupKey(b.name));
        const cellsMap = sumBy(rows, row => (isBlank(row[a.name]) || isBlank(row[b.name]) ? null : `${String(row[a.name]).trim()} · ${String(row[b.name]).trim()}`));
        const cells: { key: string; actual: number; expected: number }[] = [];
        for (const [ka, va] of byA) for (const [kb, vb] of byB) {
            const expected = (va * vb) / grand;
            if (expected < grand * 0.02) continue;
            cells.push({ key: `${ka} · ${kb}`, actual: cellsMap.get(`${ka} · ${kb}`) || 0, expected });
        }
        const worst = Math.max(0, ...cells.map(c => Math.abs(c.actual / c.expected - 1)));
        if (worst > hotspotGap) { hotspotGap = worst; hotspot = { a, b, cells }; }
    }
    if (hotspot && hotspotGap >= 0.15) {
        const sorted = [...hotspot.cells].sort((x, y) => (y.actual / y.expected) - (x.actual / x.expected));
        const high = sorted[0]; const low = sorted[sorted.length - 1];
        const gap = (c: { actual: number; expected: number }) => signedPct(c.actual / c.expected - 1);
        const lead = Math.abs(low.actual / low.expected - 1) >= Math.abs(high.actual / high.expected - 1) ? low : high;
        const other = lead === low ? high : low;
        findings.push({
            id: 'deeper_hotspot', kind: 'contrast', eyebrow: 'Breaks the pattern',
            headline: `${lead.key} is furthest from what its size predicts: ${fmt(lead.actual)} of ${main.label}, where the usual split of ${hotspot.a.label} and ${hotspot.b.label} would give ${fmt(lead.expected)} (${gap(lead)}).`,
            points: [
                `The prediction takes how big ${lead.key.split(' · ')[0]} is overall and how big ${lead.key.split(' · ')[1]} is overall; a gap this size means the two do not simply add up here.`,
                `At the other end, ${other.key} is ${gap(other)} against its prediction (${fmt(other.actual)} vs ${fmt(other.expected)}).`,
            ],
            chart: bar([...hotspot.cells].sort((x, y) => Math.abs(y.actual / y.expected - 1) - Math.abs(x.actual / x.expected - 1)).slice(0, 8)
                .map(c => ({ group: c.key, value: Math.round((c.actual / c.expected - 1) * 1000) / 10 })), `% above or below prediction`, { ...main, numberFormat: 'auto' }),
            ask: `Show ${main.label} by ${hotspot.a.label} and ${hotspot.b.label}`,
            score: 80 + Math.min(10, hotspotGap * 10),
        });
    }

    // ── averaged measures (ratings, minutes, prices): who is best and worst ──
    for (const m of measures.filter(x => x.agg === 'avg' || (x !== main && !x.money && x.agg === 'sum' && /minutes|time|days|hours|duration|rating|score|wait/i.test(x.name)))) {
        let best: { g: Grouping; top: { key: string; avg: number; n: number }; bottom: { key: string; avg: number; n: number }; spread: number } | undefined;
        const values = rows.map(row => asNumber(row[m.name])).filter((v): v is number => v !== null);
        if (values.length < 30) continue;
        const overall = values.reduce((s, v) => s + v, 0) / values.length;
        if (!overall) continue;
        for (const g of useful) {
            const acc = new Map<string, { s: number; n: number }>();
            for (const row of rows) { const k = groupKey(g.name)(row); const v = asNumber(row[m.name]); if (k === null || v === null) continue; const e = acc.get(k) || { s: 0, n: 0 }; e.s += v; e.n++; acc.set(k, e); }
            const groups = [...acc.entries()].filter(([, e]) => e.n >= 15).map(([key, e]) => ({ key, avg: e.s / e.n, n: e.n })).sort((x, y) => y.avg - x.avg);
            if (groups.length < 2) continue;
            const spread = (groups[0].avg - groups[groups.length - 1].avg) / Math.abs(overall);
            if (!best || spread > best.spread) best = { g, top: groups[0], bottom: groups[groups.length - 1], spread };
        }
        if (!best || best.spread < 0.08) continue;
        const f = (v: number) => compact(v, m.symbol);
        findings.push({
            id: `deeper_avg_${m.name}`, kind: 'breakdown', eyebrow: `Average ${m.label}`,
            headline: `Average ${m.label} differs most by ${best.g.label}: ${f(best.top.avg)} for ${best.top.key} against ${f(best.bottom.avg)} for ${best.bottom.key} (overall ${f(overall)}).`,
            points: [
                `That is a ${pct(best.spread)} gap relative to the overall average, from ${count(best.top.n)} and ${count(best.bottom.n)} rows, so it is not down to a handful of rows.`,
            ],
            ask: `Average ${m.label} by ${best.g.label}`,
            score: 66 + Math.min(14, best.spread * 20),
        });
    }

    // ── what moves together, row by row ──
    const numeric = measures.filter(m => m.name !== '__rows').slice(0, 10);
    let pairBest: { a: Measure; b: Measure; r: number } | undefined;
    for (let i = 0; i < numeric.length; i++) for (let j = i + 1; j < numeric.length; j++) {
        const a = numeric[i]; const b = numeric[j];
        const xs: number[] = []; const ys: number[] = [];
        for (const row of rows) { const x = asNumber(row[a.name]); const y = asNumber(row[b.name]); if (x !== null && y !== null) { xs.push(x); ys.push(y); } }
        if (xs.length < 30) continue;
        const mx = xs.reduce((s, v) => s + v, 0) / xs.length; const my = ys.reduce((s, v) => s + v, 0) / ys.length;
        let sxy = 0, sxx = 0, syy = 0;
        for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
        const r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
        // Near-perfect pairs are usually one worked out from the other (net = gross − discount).
        if (Math.abs(r) >= 0.97 || Math.abs(r) < 0.3) continue;
        const said = alreadySaid.some(text => text.toLowerCase().includes(a.label) && text.toLowerCase().includes(b.label));
        if (!said && (!pairBest || Math.abs(r) > Math.abs(pairBest.r))) pairBest = { a, b, r };
    }
    if (pairBest) {
        const { a, b, r } = pairBest;
        const both = rows.map(row => ({ x: asNumber(row[a.name]), y: asNumber(row[b.name]) })).filter((p): p is { x: number; y: number } => p.x !== null && p.y !== null).sort((p, q) => p.x - q.x);
        const quarter = Math.max(1, Math.floor(both.length / 4));
        const avgY = (list: { y: number }[]) => list.reduce((s, p) => s + p.y, 0) / list.length;
        const low = avgY(both.slice(0, quarter)); const high = avgY(both.slice(-quarter));
        findings.push({
            id: 'deeper_together', kind: 'relationship', eyebrow: 'Moves together',
            headline: `When ${a.label} is higher, ${b.label} tends to be ${r > 0 ? 'higher' : 'lower'}: the quarter of rows with the most ${a.label} average ${compact(high, b.symbol)} of ${b.label}, against ${compact(low, b.symbol)} for the quarter with the least.`,
            points: [
                `The link is ${Math.abs(r) >= 0.6 ? 'strong' : Math.abs(r) >= 0.45 ? 'clear' : 'moderate'} (correlation ${r.toFixed(2)}). It shows the two go together, not that one causes the other.`,
            ],
            ask: `Compare ${b.label} for high and low ${a.label}`,
            score: 60 + Math.abs(r) * 20,
        });
    }

    // ── weekday rhythm ──
    if (dateColumn && months.length >= 2) {
        const perDay = new Map<number, { sum: number; dates: Set<string> }>();
        for (const row of rows) {
            const d = dayOf(row); const v = val(main, row);
            if (!d || d.length < 10 || v === null) continue;
            const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
            const e = perDay.get(wd) || { sum: 0, dates: new Set<string>() }; e.sum += v; e.dates.add(d); perDay.set(wd, e);
        }
        const avg = [...perDay.entries()].filter(([, e]) => e.dates.size >= 4).map(([wd, e]) => ({ wd, avg: e.sum / e.dates.size })).sort((x, y) => y.avg - x.avg);
        if (avg.length >= 5) {
            const top = avg[0]; const bottom = avg[avg.length - 1];
            const lift = bottom.avg ? top.avg / bottom.avg - 1 : 0;
            if (lift >= 0.15) findings.push({
                id: 'deeper_weekday', kind: 'breakdown', eyebrow: 'Day of the week',
                headline: `${WEEKDAYS[top.wd]} is the strongest day: an average ${WEEKDAYS[top.wd]} brings ${fmt(top.avg)} of ${main.label}, ${pct(lift)} more than an average ${WEEKDAYS[bottom.wd]} (${fmt(bottom.avg)}).`,
                points: [`Averaged per calendar day, so a month with more ${WEEKDAYS[top.wd]}s does not tilt it.`],
                chart: bar([1, 2, 3, 4, 5, 6, 0].map(wd => avg.find(a => a.wd === wd)).filter((a): a is { wd: number; avg: number } => Boolean(a)).map(a => ({ group: WEEKDAYS[a.wd].slice(0, 3), value: round(a.avg) })), `Average ${main.label} per day`),
                ask: `${main.label} by day of the week`,
                score: 58 + Math.min(12, lift * 10),
            });
        }
    }

    // ── value per record ──
    if (idColumn && main.name !== '__rows') {
        let best: { g: Grouping; top: { key: string; per: number }; bottom: { key: string; per: number }; spread: number } | undefined;
        const recordWord = human(idColumn.name).replace(/\s*(id|number|no|num|ref|reference|code|key)$/i, '').trim() || 'record';
        for (const g of useful) {
            const acc = new Map<string, { s: number; ids: Set<string> }>();
            for (const row of rows) {
                const k = groupKey(g.name)(row); const v = val(main, row); const id = row[idColumn.name];
                if (k === null || v === null || isBlank(id)) continue;
                const e = acc.get(k) || { s: 0, ids: new Set<string>() }; e.s += v; e.ids.add(String(id)); acc.set(k, e);
            }
            const groups = [...acc.entries()].filter(([, e]) => e.ids.size >= 15).map(([key, e]) => ({ key, per: e.s / e.ids.size })).sort((x, y) => y.per - x.per);
            if (groups.length < 2 || !groups[groups.length - 1].per) continue;
            const spread = groups[0].per / groups[groups.length - 1].per - 1;
            if (!best || spread > best.spread) best = { g, top: groups[0], bottom: groups[groups.length - 1], spread };
        }
        if (best && best.spread >= 0.2) findings.push({
            id: 'deeper_per_record', kind: 'breakdown', eyebrow: `Per ${recordWord}`,
            headline: `An average ${recordWord} is worth ${fmt(best.top.per)} of ${main.label} for ${best.top.key}, but ${fmt(best.bottom.per)} for ${best.bottom.key}: ${pct(best.spread)} more.`,
            points: [`So ${best.top.key} gets more from each ${recordWord}, not just more of them.`],
            ask: `Average ${main.label} per ${recordWord} by ${best.g.label}`,
            score: 62 + Math.min(10, best.spread * 5),
        });
    }

    // ── which groups swing most from month to month ──
    if (months.length >= 6) {
        let best: { g: Grouping; key: string; cv: number; lo: number; hi: number } | undefined;
        for (const g of useful.filter(x => x.distinct <= 15)) {
            const series = new Map<string, Map<string, number>>();
            for (const row of rows) {
                const k = groupKey(g.name)(row); const d = dayOf(row); const v = val(main, row);
                if (k === null || !d || v === null) continue;
                const s = series.get(k) || new Map<string, number>(); s.set(d.slice(0, 7), (s.get(d.slice(0, 7)) || 0) + v); series.set(k, s);
            }
            for (const [key, s] of series) {
                const vals = months.map(m => s.get(m) || 0);
                const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
                if (mean <= 0) continue;
                const cv = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) / mean;
                if (!best || cv > best.cv) best = { g, key, cv, lo: Math.min(...vals), hi: Math.max(...vals) };
            }
        }
        if (best && best.cv >= 0.35) findings.push({
            id: 'deeper_swing', kind: 'anomaly', eyebrow: 'Least steady',
            headline: `${best.key} (${best.g.label}) swings the most from month to month: between ${fmt(best.lo)} and ${fmt(best.hi)} of ${main.label}.`,
            points: [`Its months vary by ${pct(best.cv)} on average around its usual level, so a single month for ${best.key} says little on its own.`],
            ask: `${main.label} by month for ${best.key}`,
            score: 54 + Math.min(10, best.cv * 10),
        });
    }

    // ── one level deeper each time, never repeating ──
    const fresh = findings.filter(f => !alreadySaid.some(text => text.trim().startsWith(f.headline))).sort((a, b) => b.score - a.score);
    const level = Math.max(1, depth);
    // Earlier looks are in alreadySaid, so the freshest findings come first at every depth.
    const picked = fresh.slice(0, FINDINGS_PER_LOOK);
    const topics: Record<string, string> = {
        deeper_recent: 'what drove the latest change', deeper_yoy: 'what is behind the change on a year ago', deeper_hotspot: 'which combinations break the usual pattern',
        deeper_together: 'which measures move together', deeper_weekday: 'the weekly rhythm', deeper_per_record: 'value per record', deeper_swing: 'which groups are least steady',
    };
    const looked = picked.map(f => topics[f.id] || (f.id.startsWith('deeper_avg_') ? `how ${f.eyebrow.toLowerCase()} differs` : '')).filter(Boolean);
    const list = looked.length > 1 ? `${looked.slice(0, -1).join(', ')} and ${looked[looked.length - 1]}` : looked[0] || '';
    return {
        title: level === 1 ? `A closer look at ${name}` : `Digging further into ${name}`,
        summary: picked.length
            ? `Past the headline numbers, I looked into ${list}. Every figure comes from all ${count(rows.length)} rows.`
            : `That is everything that stands out in ${name} without a more specific question. Ask about one column, group or period to go further.`,
        findings: picked,
        rowCount: rows.length,
        exhausted: picked.length === 0,
    };
}
