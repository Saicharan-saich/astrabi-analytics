/**
 * builderFromWords.ts — a question typed in plain words, turned into a
 * Question Builder question. Worked out on this computer from the column
 * names and the values in the data; nothing is sent to an AI.
 *
 *   "top 5 menu items by sales last 3 months in Leeds"
 *     → measure gross_sales (total), split by menu_item, top 5,
 *       last 3 months, only location = Leeds
 *
 * It reports what it understood (so the person can check it) and the words it
 * could not place (so it never guesses silently). The builder's own controls
 * are filled from the result, so everything stays editable.
 */
import { ColumnType, type ColumnDefinition, type Dataset } from '../types';
import { spokenName } from '../utils/spokenName';
import { primaryDateColumn } from '../utils/explore';
import { describeDatasetShape } from './datasetShape';
import { mainAmountAndGroups } from './ai-sql/starterQuestions';

type Row = Record<string, any>;
export type UnderstoodSlot = 'measure' | 'split' | 'time' | 'filter' | 'top' | 'compare';
export interface Understood { slot: UnderstoodSlot; text: string }
export interface WordsQuestion {
    config: Record<string, unknown>;
    understood: Understood[];
    /** Words that were not used for anything. */
    unused: string[];
    /** No amount was named, so the file's main amount was used. */
    usedDefaultMeasure: boolean;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const GRAINS: Record<string, string> = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month', quarter: 'quarter', quarterly: 'quarter', year: 'year', yearly: 'year', annually: 'year', annual: 'year' };
const FILLER = new Set(['show', 'me', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'at', 'to', 'from', 'is', 'are', 'was', 'were', 'what', 'whats', 'which', 'how', 'did', 'do', 'does', 'we', 'our', 'my', 'i', 'give', 'get', 'see', 'tell', 'please', 'with', 'and', 'or', 'by', 'per', 'each', 'every', 'all', 'only', 'just', 'chart', 'graph', 'table', 'list', 'plot', 'breakdown', 'broken', 'down', 'split', 'grouped', 'group', 'across', 'it', 'there', 'have', 'has', 'had', 'much', 'many', 'make', 'made', 'sell', 'sold', 'sells', 'bring', 'brought', 'compare', 'between', 'than', 'that', 'this', 'these', 'those', 'be', 'been', 'over', 'into', 'up', 'out', 'so', 'far', 'about', 'can', 'you', 'want', 'know', 'like', 'look', 'see', 'where', 'when', 'who', 'come', 'came', 'from']);
/** Everyday words for amounts, matched against column names. */
const AMOUNT_WORDS: Array<[RegExp, RegExp]> = [
    [/^(sales|revenue|turnover|takings|income|money|earnings)$/, /sales|revenue|turnover|amount|income|takings|value|total/],
    [/^(profit|profits|margin|margins)$/, /profit|margin/],
    [/^(cost|costs|spend|spending|expense|expenses)$/, /cost|spend|expense/],
    [/^(quantity|units|qty|volume)$/, /quantity|qty|units|volume|count/],
    [/^(rating|ratings|score|scores|stars|satisfaction)$/, /rating|score|satisfaction|stars/],
    [/^(discount|discounts)$/, /discount/],
];
/** Everyday words for groupings. */
const GROUP_WORDS: Array<[RegExp, RegExp]> = [
    [/^(store|stores|shop|shops|branch|branches|site|sites|outlet|outlets|restaurant|restaurants)$/, /store|shop|branch|site|location|outlet|restaurant/],
    [/^(product|products|item|items|dish|dishes|sku|skus)$/, /product|item|dish|sku|title/],
    [/^(customer|customers|client|clients|buyer|buyers)$/, /customer|client|buyer|account/],
    [/^(area|areas|region|regions)$/, /region|area|territory/],
    [/^(type|types|kind|kinds|category|categories)$/, /category|type|kind/],
];
const ENTITY = /^(orders?|transactions?|bookings?|tickets?|invoices?|visits?|purchases?)$/;

const singular = (w: string) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/(ches|shes|xes|sses)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1') : w);
const norm = (text: string) => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9£$€%.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
const isBlank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';

interface Tok { w: string; start: number; end: number; used: boolean }

function tokenize(text: string): Tok[] {
    const out: Tok[] = [];
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ w: m[0].replace(/[.,]$/, ''), start: m.index, end: m.index + m[0].length, used: false });
    return out;
}

/** Name variants a person might type for a column, longest first. */
function variants(col: ColumnDefinition, all: ColumnDefinition[]): string[][] {
    const spoken = spokenName(col.name).split(' ').filter(Boolean);
    const raw = col.name.toLowerCase().split(/[_\s.-]+/).filter(Boolean);
    const out = [spoken, raw, spoken.map(singular)];
    // The last word alone ("item" for menu_item) when no other column ends the same way.
    const last = singular(spoken[spoken.length - 1] || '');
    const sameEnd = all.filter(c => singular(spokenName(c.name).split(' ').pop() || '') === last);
    if (last && spoken.length > 1 && sameEnd.length === 1 && !/^(id|name|date|code|number|no)$/.test(last)) out.push([last]);
    // "order id" → "order"
    if (col.type === ColumnType.ID && spoken.length > 1 && /^(id|number|no|ref|code)$/.test(spoken[spoken.length - 1])) out.push(spoken.slice(0, -1));
    const seen = new Set<string>();
    return out.filter(v => v.length && !seen.has(v.join(' ')) && seen.add(v.join(' '))).sort((a, b) => b.length - a.length);
}

export function questionFromWords(dataset: Dataset, text: string, asOf?: string): WordsQuestion {
    const rows = (dataset.rows || []) as Row[];
    const columns = dataset.columns.filter(c => !c.name.startsWith('__'));
    const metrics = columns.filter(c => c.type === ColumnType.METRIC);
    const groupable = columns.filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.BOOLEAN);
    const idCol = columns.find(c => c.type === ColumnType.ID);
    const dateCol = primaryDateColumn(dataset);
    const understood: Understood[] = [];
    const config: Record<string, unknown> = {};

    const work = { text: ` ${norm(text)} ` };
    const toks = tokenize(work.text);
    /** Take a phrase (regex on the remaining text); its words are then used. */
    const take = (re: RegExp): RegExpExecArray | null => {
        const m = new RegExp(re.source, re.flags.replace('g', '')).exec(work.text);
        if (!m) return null;
        const s = m.index, e = m.index + m[0].length;
        work.text = work.text.slice(0, s) + ' '.repeat(m[0].length) + work.text.slice(e);
        for (const t of toks) if (t.start >= s && t.end <= e) t.used = true;
        return m;
    };
    const free = () => toks.filter(t => !t.used && work.text.slice(t.start, t.end).trim());
    const useTok = (t: Tok) => { t.used = true; work.text = work.text.slice(0, t.start) + ' '.repeat(t.end - t.start) + work.text.slice(t.end); };

    const today = (() => {
        const d = asOf ? new Date(`${asOf.slice(0, 10)}T12:00:00Z`) : new Date();
        return Number.isNaN(d.getTime()) ? new Date() : d;
    })();
    const dateFilters: Array<{ column: string; timeGrain: string; values: string[] }> = [];
    const pad = (n: number) => String(n).padStart(2, '0');

    // ── comparisons ──
    if (take(/\b(?:vs|versus|v|compared? (?:to|with)|against)\.? (?:the )?(?:same (?:period|time|month|quarter|week) )?(?:last|previous|prior) year\b|\b(?:year on year|year over year|yoy|same period last year)\b/)) {
        Object.assign(config, { comparison: 'same_period_last_n', comparisonGrain: 'year', comparisonOffset: 1 });
        understood.push({ slot: 'compare', text: 'compared with the same period a year earlier' });
    } else if (take(/\b(?:vs|versus|v|compared? (?:to|with)|against)\.? (?:the )?(?:last|previous|prior|preceding) (?:period|month|week|quarter|day|one)\b|\b(?:vs|versus) (?:before|previous)\b|\b(?:period on period|month on month|week on week|mom|wow)\b/)) {
        config.comparison = 'previous_period';
        understood.push({ slot: 'compare', text: 'compared with the period before' });
    }

    // ── time ranges ──
    let m: RegExpExecArray | null;
    const setTime = (key: string, label: string) => { config.timeFilter = key; understood.push({ slot: 'time', text: label }); };
    if (take(/\btoday\b/)) setTime('today', 'today');
    else if (take(/\byesterday\b/)) setTime('yesterday', 'yesterday');
    else if ((m = take(/\b(?:this|current) (week|month|quarter|year)\b/))) setTime(`this_${m[1]}`, `this ${m[1]}`);
    else if (take(/\b(?:year to date|ytd)\b/)) setTime('this_year', 'this year so far');
    else if ((m = take(/\b(?:last|past|previous|prior) (\d{1,3}) (day|week|month|year)s?\b/))) setTime(`last_${m[1]}_${m[2]}s`, `the last ${m[1]} ${m[2]}${m[1] === '1' ? '' : 's'}`);
    else if (take(/\b(?:last|previous|prior) year\b/)) setTime('last_year', `last year (${today.getUTCFullYear() - 1})`);
    else if (take(/\b(?:last|previous|prior|past) week\b/)) setTime('last_7_days', 'the last 7 days');
    else if (dateCol && take(/\b(?:last|previous|prior) month\b/)) {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
        dateFilters.push({ column: dateCol, timeGrain: 'month', values: [`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`] });
        understood.push({ slot: 'time', text: `last month (${d.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })})` });
    } else if (dateCol && take(/\b(?:last|previous|prior) quarter\b/)) {
        const q = Math.floor(today.getUTCMonth() / 3); const year = q === 0 ? today.getUTCFullYear() - 1 : today.getUTCFullYear(); const prev = q === 0 ? 4 : q;
        dateFilters.push({ column: dateCol, timeGrain: 'quarter', values: [`${year}-Q${prev}`] });
        understood.push({ slot: 'time', text: `last quarter (Q${prev} ${year})` });
    } else if (dateCol && (m = take(/\b(?:in |during |for )?q([1-4])(?: (\d{4}))?\b/))) {
        const year = m[2] ? Number(m[2]) : (Number(m[1]) <= Math.floor(today.getUTCMonth() / 3) + 1 ? today.getUTCFullYear() : today.getUTCFullYear() - 1);
        dateFilters.push({ column: dateCol, timeGrain: 'quarter', values: [`${year}-Q${m[1]}`] });
        understood.push({ slot: 'time', text: `Q${m[1]} ${year}` });
    } else if (dateCol && (m = take(new RegExp(`\\b(?:in |during |for )?${MONTH_RE}(?: (\\d{4}))?\\b`)))) {
        const month = MONTHS.findIndex(name => name.startsWith(m![1].slice(0, 3)));
        const year = m[2] ? Number(m[2]) : (month <= today.getUTCMonth() ? today.getUTCFullYear() : today.getUTCFullYear() - 1);
        dateFilters.push({ column: dateCol, timeGrain: 'month', values: [`${year}-${pad(month + 1)}`] });
        understood.push({ slot: 'time', text: `${MONTHS[month][0].toUpperCase()}${MONTHS[month].slice(1)} ${year}` });
    } else if (dateCol && (m = take(/\b(?:in |during |for )?((?:19|20)\d{2})\b/))) {
        dateFilters.push({ column: dateCol, timeGrain: 'year', values: [m[1]] });
        understood.push({ slot: 'time', text: m[1] });
    }
    if (dateFilters.length) config.dateFilters = dateFilters;

    // ── grouping by time ──
    let grain = '';
    if (dateCol && (m = take(/\b(?:by|per|each|every|a|by the) (day|week|month|quarter|year)\b|\b(daily|weekly|monthly|quarterly|yearly|annually|annual)\b|\b(day|week|month|quarter|year) by \3\b/))) grain = GRAINS[m[1] || m[2] || m[3]];
    else if (dateCol && take(/\b(?:over time|trend|trends|timeline|history|so far this year)\b/)) grain = 'month';

    // ── top / bottom ──
    let sort = '';
    let limit = 0;
    if ((m = take(/\b(?:top|best|highest|biggest|largest|leading) (\d{1,3})\b/))) { limit = Number(m[1]); sort = 'desc'; understood.push({ slot: 'top', text: `top ${limit}` }); }
    else if ((m = take(/\b(?:bottom|worst|lowest|smallest|least|weakest) (\d{1,3})\b/))) { limit = -Number(m[1]); sort = 'asc'; understood.push({ slot: 'top', text: `bottom ${-limit}` }); }
    else if (take(/\b(?:the )?(?:most|highest|best|biggest|top|largest)\b/)) { sort = 'desc'; understood.push({ slot: 'top', text: 'highest first' }); }
    else if (take(/\b(?:the )?(?:least|lowest|worst|fewest|smallest|bottom)\b/)) { sort = 'asc'; understood.push({ slot: 'top', text: 'lowest first' }); }

    // ── how to add up ──
    let aggregation = '';
    if (take(/\b(?:average|avg|mean|typical)\b/)) aggregation = 'AVG';
    else if (take(/\b(?:how many|number of|count of|count)\b/)) aggregation = 'COUNT';
    else if (take(/\b(?:unique|distinct)\b/)) aggregation = 'COUNT_DISTINCT';
    else if (take(/\b(?:maximum|max)\b/)) aggregation = 'MAX';
    else if (take(/\b(?:minimum|min)\b/)) aggregation = 'MIN';
    else if (take(/\b(?:total|sum of|sum)\b/)) aggregation = 'SUM';

    /** The column whose name (or everyday word) the free words at position i spell, longest first. */
    const columnAt = (i: number, pool: ColumnDefinition[]): { col: ColumnDefinition; length: number } | null => {
        const list = free();
        let best: { col: ColumnDefinition; length: number; score: number } | null = null;
        for (const col of pool) {
            for (const v of variants(col, columns)) {
                if (i + v.length > list.length) continue;
                const ok = v.every((word, k) => { const t = list[i + k].w; return t === word || singular(t) === singular(word); });
                if (ok && (!best || v.length > best.length || (v.length === best.length && best.score < 2))) best = { col, length: v.length, score: 2 };
            }
        }
        if (best) return best;
        const t = list[i]?.w;
        if (!t) return null;
        // Everyday words: amounts only for amounts, groupings only for groupings.
        const everyday = pool.some(c => c.type === ColumnType.METRIC) ? AMOUNT_WORDS : GROUP_WORDS;
        for (const [say, columnName] of everyday) {
            if (!say.test(t)) continue;
            const hits = pool.filter(c => columnName.test(spokenName(c.name)));
            if (hits.length) return { col: hits[0], length: 1 };
        }
        return null;
    };

    // ── what to split by: "by X (and Y)", "per X", "which X" ──
    const splits: ColumnDefinition[] = [];
    const splitPool = [...groupable, ...(idCol ? [idCol] : [])];
    for (let guard = 0; guard < 6; guard++) {
        const list = free();
        const at = list.findIndex((t, k) => /^(by|per|across|each|which|what|whose)$/.test(t.w) && k + 1 < list.length && columnAt(k + 1, splitPool));
        if (at < 0) break;
        const hit = columnAt(at + 1, splitPool)!;
        const used = list.slice(at, at + 1 + hit.length);
        used.forEach(useTok);
        if (!splits.includes(hit.col)) splits.push(hit.col);
        // "and Y", ", Y", "then Y" straight after
        for (;;) {
            const after = free();
            const k = after.findIndex(t => t.start > used[used.length - 1].end);
            if (k < 0 || !/^(and|then|&)$/.test(after[k].w)) break;
            const next = columnAt(k + 1, splitPool);
            if (!next) break;
            after.slice(k, k + 1 + next.length).forEach(useTok);
            if (!splits.includes(next.col)) splits.push(next.col);
        }
    }

    // ── which amount ──
    const measures: ColumnDefinition[] = [];
    let entity: ColumnDefinition | undefined;
    for (let k = 0; k < free().length;) {
        const list = free();
        const t = list[k];
        if (idCol && ENTITY.test(t.w) && (aggregation === 'COUNT' || aggregation === '' ) && !metrics.some(c => variants(c, columns).some(v => v.length === 1 && singular(v[0]) === singular(t.w)))) {
            // "how many orders", "orders by location": count the different order IDs
            if (aggregation === 'COUNT' || !measures.length) { entity = idCol; useTok(t); continue; }
        }
        const hit = columnAt(k, metrics);
        if (hit) { list.slice(k, k + hit.length).forEach(useTok); if (!measures.includes(hit.col)) measures.push(hit.col); continue; }
        // "how many customers": count different values of a grouping
        if (aggregation === 'COUNT' || aggregation === 'COUNT_DISTINCT') {
            const g = columnAt(k, groupable);
            if (g && !splits.includes(g.col)) { list.slice(k, k + g.length).forEach(useTok); entity = g.col; continue; }
        }
        k++;
    }

    // ── a grouping named without "by": "top 5 menu items", "lowest 3 stores" ──
    if (!splits.length) {
        const list = free();
        for (let k = 0; k < list.length; k++) {
            const hit = columnAt(k, groupable);
            if (!hit) continue;
            // Only a name, not a value: "Leeds" stays a filter.
            list.slice(k, k + hit.length).forEach(useTok);
            splits.push(hit.col);
            break;
        }
    }

    // ── filters: values in the data ("Leeds", "burgers", "excluding Delivery") ──
    const filters: Record<string, string[]> = {};
    const valueIndex = buildValueIndex(rows, groupable);
    for (let guard = 0; guard < 8; guard++) {
        const list = free();
        let found: { col: string; values: string[]; from: number; length: number; exclude: boolean; text: string } | null = null;
        for (let n = Math.min(4, list.length); n >= 1 && !found; n--) {
            for (let i = 0; i + n <= list.length && !found; i++) {
                const phrase = list.slice(i, i + n).map(t => t.w).join(' ');
                if (n === 1 && (FILLER.has(phrase) || phrase.length < 3)) continue;
                const exact = valueIndex.exact.get(phrase) || valueIndex.exact.get(singular(phrase));
                const partial = !exact && n === 1 ? valueIndex.words.get(singular(phrase)) : undefined;
                const hit = exact || (partial && partial.size === 1 ? { col: [...partial.keys()][0], values: [...[...partial.values()][0]] } : undefined);
                if (!hit) continue;
                const before = list[i - 1]?.w;
                found = { col: hit.col, values: hit.values, from: i, length: n, exclude: /^(excluding|except|not|without|excl|exclude|minus)$/.test(before || ''), text: phrase };
                if (found.exclude) useTok(list[i - 1]);
            }
        }
        if (!found) break;
        list.slice(found.from, found.from + found.length).forEach(useTok);
        if (splits.some(s => s.name === found!.col) && !found.exclude) {
            // "sales by location in Leeds": the value filters the split, which is fine.
        }
        const all = valueIndex.all.get(found.col) || [];
        const chosen = found.exclude ? all.filter(v => !found!.values.includes(v)) : found.values;
        if (!chosen.length) continue;
        filters[found.col] = [...new Set([...(filters[found.col] || []), ...chosen])];
        const shown = found.values.length > 3 ? `${found.values.slice(0, 3).join(', ')}…` : found.values.join(', ');
        understood.push({ slot: 'filter', text: `${found.exclude ? 'not ' : 'only '}${shown} (${spokenName(found.col)})` });
    }
    if (Object.keys(filters).length) config.filters = filters;

    // ── put it together ──
    let usedDefaultMeasure = false;
    let metric: ColumnDefinition | undefined = measures[0];
    if (entity) {
        metric = entity;
        aggregation = 'COUNT_DISTINCT';
    } else if (!metric) {
        if (aggregation === 'COUNT') metric = idCol;
        if (!metric) {
            let shape; try { shape = describeDatasetShape(dataset); } catch { shape = undefined; }
            const main = shape ? mainAmountAndGroups(dataset, shape).amount : undefined;
            metric = columns.find(c => c.name === main) || metrics[0] || idCol;
            usedDefaultMeasure = true;
        }
    }
    if (!aggregation) aggregation = metric && /rating|score|percent|pct|rate|ratio|minutes|age|price|duration/.test(spokenName(metric.name)) ? 'AVG' : 'SUM';
    if (metric?.type === ColumnType.ID && aggregation === 'COUNT') aggregation = 'COUNT_DISTINCT';
    config.metric = metric?.name;
    config.aggregation = aggregation;
    const howWord: Record<string, string> = { SUM: 'total', AVG: 'average', COUNT: 'number of', COUNT_DISTINCT: 'number of different', MAX: 'highest', MIN: 'lowest' };
    if (metric) {
        const name = spokenName(metric.name).replace(/ (id|number|no|ref|code)$/, metric.type === ColumnType.ID ? 's' : ' $1');
        const also = measures.slice(1).map(c => spokenName(c.name));
        understood.unshift({ slot: 'measure', text: `${howWord[aggregation] || ''} ${name}${also.length ? ` and ${also.join(' and ')}` : ''}${usedDefaultMeasure ? ' (your main amount)' : ''}`.trim() });
    }
    if (measures.length > 1) config.secondaryMetrics = measures.slice(1).map(c => c.name);

    const splitNames = splits.map(c => c.name);
    if (grain) {
        config.dimension = grain;
        if (splitNames.length) config.secondaryDimensions = splitNames;
        understood.splice(1, 0, { slot: 'split', text: `by ${grain}${splitNames.length ? ` and ${splitNames.map(spokenName).join(' and ')}` : ''}` });
    } else if (splitNames.length) {
        config.dimension = splitNames[0];
        if (splitNames.length > 1) config.secondaryDimensions = splitNames.slice(1);
        understood.splice(1, 0, { slot: 'split', text: `by ${splitNames.map(spokenName).join(' and ')}` });
    }
    if (config.comparison && !config.dimension && dateCol && !config.timeFilter && !dateFilters.length) {
        // "sales vs last month" with no period: compare this month with the one before.
        config.timeFilter = 'this_month';
        understood.push({ slot: 'time', text: 'this month' });
    }
    config.sort = sort || (grain ? 'oldest' : config.dimension ? 'desc' : '');
    if (!config.sort) delete config.sort;
    if (limit) config.limit = limit;
    if (!config.timeFilter) config.timeFilter = 'all_time';

    const unused = free().map(t => t.w).filter(w => !FILLER.has(w) && !/^\d+$/.test(w) && w.length > 1);
    return { config, understood, unused, usedDefaultMeasure };
}

/** Category values to recognise: exact (normalised) and by single words ("burger" → "Classic Burger"). */
function buildValueIndex(rows: Row[], groupable: ColumnDefinition[]) {
    const exact = new Map<string, { col: string; values: string[] }>();
    const words = new Map<string, Map<string, Set<string>>>();
    const all = new Map<string, string[]>();
    const sample = rows.length > 20000 ? rows.slice(0, 20000) : rows;
    for (const col of groupable) {
        const seen = new Set<string>();
        for (const row of sample) {
            const v = row[col.name];
            if (isBlank(v)) continue;
            seen.add(String(v).trim());
            if (seen.size > 1000) break;
        }
        if (seen.size > 1000) continue;
        all.set(col.name, [...seen]);
        for (const value of seen) {
            const key = norm(value);
            if (!key) continue;
            const prev = exact.get(key);
            if (!prev) exact.set(key, { col: col.name, values: [value] });
            for (const w of key.split(' ')) {
                const s = singular(w);
                if (s.length < 3 || FILLER.has(s)) continue;
                const byCol = words.get(s) || new Map<string, Set<string>>();
                const set = byCol.get(col.name) || new Set<string>();
                set.add(value);
                byCol.set(col.name, set);
                words.set(s, byCol);
            }
        }
    }
    return { exact, words, all };
}

/** Example questions for this file, each checked to be fully understood. */
export function exampleQuestions(dataset: Dataset, asOf?: string): string[] {
    let shape; try { shape = describeDatasetShape(dataset); } catch { return []; }
    const { amount, groups } = mainAmountAndGroups(dataset, shape);
    if (!amount) return [];
    const money = spokenName(amount);
    const [g1, g2] = groups.map(spokenName);
    const plural = (w: string) => (/(s|x|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
    const hasDate = Boolean(primaryDateColumn(dataset));
    const candidates = [
        g1 && hasDate ? `${money} by ${g1} last 3 months` : '',
        g1 ? `top 5 ${plural(g1)} by ${money}` : '',
        hasDate ? `${money} by month this year` : '',
        g2 && hasDate ? `${money} by month for each ${g2}` : '',
        hasDate ? `${money} by month vs last year` : '',
    ].filter(Boolean);
    return candidates.filter(q => { const r = questionFromWords(dataset, q, asOf); return !r.unused.length && !r.usedDefaultMeasure; }).slice(0, 3);
}
