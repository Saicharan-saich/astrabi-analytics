/**
 * The briefing: answers before the owner asks. From any dataset with dates,
 * the latest full week (or month, for monthly data) is compared with a usual
 * one, and the briefing says what changed, what explains it, and what to look
 * at — worked out in the browser from the cleaned rows. Nothing leaves it.
 *
 * Everything comes from the data's own shape, never from a particular file:
 *   - the period: weeks when the data is dated by day or week, months when
 *     it is dated by month; the latest *full* one (a week is full when the
 *     days the business normally trades have all come in);
 *   - the measures: the main amount that adds up (sales, takings), how many
 *     orders/visits/records, the average per order, and the tracked outcome's
 *     rate (no-shows) for records data;
 *   - "usual": the average of the periods before; "unusual" only when the
 *     change is beyond the data's own normal swing (1.5 × the standard
 *     deviation of those periods) and at least 5%;
 *   - what explains it: the category whose change accounts for most of the
 *     difference; the weekday furthest from a usual one; a run of three or
 *     more falls or rises; items that stopped or started; a rate outside its
 *     usual range (judged with the same 95% rule as the answer check).
 * Each finding carries a question to ask next, so the owner can dig in with
 * AI SQL, where every figure is checked again.
 */
import { ColumnType, type Dataset } from '../types';
import { describeDatasetShape, idWord, type DatasetShape } from './datasetShape';
import { outcomeFocus } from './recordsStory';
import { yesNoSide } from '../utils/twoValues';
import { friendlyNumber, plainName } from './ai-sql/plainLabels';
import { wilsonInterval } from '../utils/plausibility';

export type BriefingTone = 'good' | 'bad' | 'neutral';
/** The notice in the bell for a new briefing uses this rule id. */
export const BRIEFING_RULE_ID = 'weekly-briefing';

export interface BriefingFigure {
    label: string;
    value: string;
    /** "−8% vs a usual week". */
    change?: string;
    tone: BriefingTone;
}
export interface BriefingFinding {
    kind: 'driver' | 'mover' | 'weekday' | 'streak' | 'stopped' | 'started' | 'rate';
    text: string;
    /** What to look at, in one line. */
    check?: string;
    /** A question to ask AI SQL next. */
    ask?: string;
    tone: BriefingTone;
}
export interface Briefing {
    status: 'ready' | 'not-enough';
    grain: 'week' | 'month';
    /** Start of the period (Monday, or the 1st), used to tell when a new one is ready. */
    periodKey: string;
    /** "Last week · 3–9 Nov 2025". */
    periodLabel: string;
    headline: string;
    figures: BriefingFigure[];
    findings: BriefingFinding[];
    /** The last date in the data. */
    dataUntil?: string;
    /** When the data has not been refreshed for a while. */
    stale?: string;
    /** Why there is no briefing yet. */
    reason?: string;
}

const DAY = 86_400_000;
const MONEY_NAME = /(revenue|sales|takings|turnover|income|amount|total|value|gross|net|spend|cost|price|profit|margin|payment|paid|fee|charge|billing|invoice)/i;
const ORDER_ID = /(order|transaction|txn|invoice|receipt|sale|booking|visit|appointment|ticket|basket|checkout)/i;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const toNumber = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || !v.trim()) return null;
    const n = Number(v.replace(/[,£$€\s]/g, ''));
    return Number.isFinite(n) ? n : null;
};
const toDay = (v: unknown): string | null => {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(ms(day)).getUTCDay();
const mondayOf = (day: string) => dayOf(ms(day) - ((weekday(day) + 6) % 7) * DAY);
const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / Math.max(xs.length, 1);
const sd = (xs: number[]) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (xs.length - 1)); };
const pctText = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const fmtDay = (day: string, withYear = false) => new Date(ms(day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' });
const symbolFor = (currency?: string) => {
    if (!currency) return '';
    try { return (0).toLocaleString('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).replace(/[\d\s.,]/g, ''); } catch { return ''; }
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

interface Measure { name: string; label: string; symbol: string }

const words = (name: string) => name.toLowerCase().replace(/([a-z])([A-Z])/g, '$1_$2').split(/[^a-z0-9]+/).filter(Boolean);
const hasWord = (name: string, re: RegExp) => words(name).some(w => re.test(w));

/**
 * What a category column is, from its name: something sold, a place, a way to
 * buy or pay, a member of staff, a trait of a person, or a status. It decides
 * which findings make sense and what to suggest; anything else is described
 * without advice.
 */
export type CategoryKind = 'offer' | 'place' | 'channel' | 'staff' | 'trait' | 'status' | 'other';
export function categoryKind(name: string): CategoryKind {
    if (hasWord(name, /^(status|state|result|outcome|stage|success|failed|error|reason)$/)) return 'status';
    if (hasWord(name, /^(gender|sex|age|ethnicity|ethnic|race|marital|nationality|religion|disability|generation)$/)) return 'trait';
    if (hasWord(name, /^(staff|employee|server|cashier|team|rep|agent|doctor|stylist|therapist|driver|waiter|operator|user|seller)$/)) return 'staff';
    if (hasWord(name, /^(channel|source|platform|payment|paid|by|method|card|tender|device|medium|campaign|referrer|utm)$/)) return 'channel';
    if (hasWord(name, /^(location|store|branch|site|shop|outlet|region|city|town|area|country|postcode|venue|ward|clinic|warehouse|neighbourhood|neighborhood|county|state)$/)) return 'place';
    if (hasWord(name, /^(product|products|item|items|sku|menu|service|services|category|lineitem|line|variant|dish|drink|title|treatment|course|plan|package|model|what|brand|range|collection|style|flavour|flavor)$/)) return 'offer';
    return 'other';
}
/** Advice that fits the kind of column and the direction of the change. */
function adviceFor(kind: CategoryKind, key: string, down: boolean, periodWord: string): string | undefined {
    switch (kind) {
        case 'offer': return down ? `Check whether ${key} is in stock, priced differently or harder to find.` : `${key} is selling well — make sure there is enough of it.`;
        case 'place': return down ? `Check what changed at ${key} ${periodWord}: opening hours, staffing or something local.` : `Find out what went well at ${key} so other places can copy it.`;
        case 'channel': return down ? `Check that ${key} is working properly — fewer customers used it.` : undefined;
        case 'staff': return down ? `Check ${key}'s hours or rota ${periodWord}.` : undefined;
        default: return undefined;
    }
}
const GENERIC_RECORD = /^(row|rows|record|records|line|lines|entry|entries|item|items)$/i;
/** Tiers of the main amount: income first, then totals, then any money-like amount. */
const AMOUNT_TIERS = [/^(revenue|sales|takings|turnover|income|in|credit|credits|deposit|deposits|receipts)$/, /^(total|gross|net|amount|value|payment|payments|paid)$/];
const COST_WORDS = /^(cost|costs|expense|expenses|spend|spent|fee|fees|refund|refunds|discount|discounts|tax|vat|out|debit|debits|withdrawal|withdrawals|outgoing|outgoings|purchases|bill|bills)$/;
/** "31% below a usual week (£1,750)", or "up from £2" when the usual figure is tiny. */
function againstUsual(now: number, was: number, usualWord: string, fmt: (v: number) => string): string {
    if (!was) return `${fmt(now)}, against nothing in ${usualWord}`;
    const ratio = (now - was) / Math.abs(was);
    if (Math.abs(ratio) > 9.99) return `${now > was ? 'up' : 'down'} from ${fmt(was)} in ${usualWord}`;
    return `${Math.round(Math.abs(ratio) * 100)}% ${now >= was ? 'above' : 'below'} ${usualWord} (${fmt(was)})`;
}

/** The amount that matters most: sales/revenue/takings first, then any money-like amount. */
function mainAmount(dataset: Dataset, shape: DatasetShape): Measure | null {
    const amounts = shape.amounts.filter(name => !hasWord(name, COST_WORDS) || shape.amounts.every(a => hasWord(a, COST_WORDS)));
    // Whole words, fewest first: "total" before "subtotal"; "paid_in" before "paid_out".
    const ranked = (re: RegExp) => amounts.filter(name => hasWord(name, re)).sort((a, b) => words(a).length - words(b).length)[0];
    // Hours or minutes worked add up too (timesheets), when there is no money.
    const hours = shape.perRowNumbers.find(name => hasWord(name, /^(hours|hrs|minutes|mins|worked|duration)$/));
    const pick = AMOUNT_TIERS.map(ranked).find(Boolean) || amounts.find(name => MONEY_NAME.test(name)) || amounts[0] || hours;
    if (!pick) return null;
    const column = dataset.columns.find(c => c.name === pick);
    // The column's own currency, or the one a "currency" column names for every row (GBP).
    let currency = (column as any)?.currency as string | undefined;
    if (!currency && !hasWord(pick, /^(hours|hrs|minutes|mins|worked|duration)$/)) {
        const currencyCol = Object.keys(dataset.rows[0] || {}).find(name => hasWord(name, /^(currency|ccy)$/));
        const codes = currencyCol ? new Set(dataset.rows.slice(0, 2000).map(r => String(r[currencyCol] ?? '').trim().toUpperCase()).filter(Boolean)) : new Set<string>();
        if (codes.size === 1 && /^[A-Z]{3}$/.test([...codes][0])) currency = [...codes][0];
    }
    return { name: pick, label: plainName(pick), symbol: symbolFor(currency) };
}

/** What one "order" is: a repeating order/transaction ID when lines repeat, else one row. */
function countUnit(shape: DatasetShape, rows: Record<string, any>[]): { id?: string; word: string; generic: boolean } {
    const id = shape.entityIds.find(name => ORDER_ID.test(name));
    if (id) return { id, word: idWord(id) || 'order', generic: false };
    // An order number written on each line of a multi-line order ("#1001").
    const sample = rows.slice(0, 2000);
    const orderNumber = Object.keys(rows[0] || {}).find(name => {
        const values = sample.map(r => r[name]).filter(v => !isBlank(v)).map(String);
        if (values.length < sample.length * 0.9) return false;
        const distinct = new Set(values).size;
        // Written like an order number ("#1001", "INV-204"), not a plain number (a patient ID).
        return distinct < values.length && distinct > values.length * 0.2 && values.filter(v => /^(#\d{3,}|[A-Z]{1,4}-?\d{3,})$/i.test(v.trim())).length >= values.length * 0.9;
    });
    if (orderNumber) return { id: orderNumber, word: ORDER_ID.test(orderNumber) ? idWord(orderNumber) || 'order' : 'order', generic: false };
    const word = shape.recordWord || 'record';
    return { word, generic: GENERIC_RECORD.test(word) };
}
const pluralWord = (word: string) => /(s|x|ch|sh)$/.test(word) ? `${word}es` : /[^aeiou]y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;

interface Period { key: string; days: Set<string>; rows: Record<string, any>[] }

/** Build the briefing for the latest full week or month in the data. */
export function buildBriefing(dataset: Dataset, today: Date = new Date()): Briefing {
    const notEnough = (reason: string, grain: 'week' | 'month' = 'week'): Briefing => ({ status: 'not-enough', grain, periodKey: '', periodLabel: '', headline: '', figures: [], findings: [], reason });
    const rows = dataset.rows || [];
    if (!rows.length) return notEnough('There is no data yet.');
    const shape = describeDatasetShape(dataset);
    const anchor = dataset.timeContext?.anchorDateColumn;
    const dateCol = (anchor && anchor in rows[0] ? anchor : undefined)
        || dataset.columns.find(c => c.type === ColumnType.DATE && rows.some(r => toDay(r[c.name])))?.name
        || shape.dates.find(name => rows.some(r => toDay(r[name])));
    if (!dateCol) return notEnough('A briefing compares one week with the weeks before, so it needs a date column (an order date, a visit date).');

    const dated = rows.map(row => ({ row, day: toDay(row[dateCol]) })).filter((x): x is { row: Record<string, any>; day: string } => Boolean(x.day));
    const days = [...new Set(dated.map(x => x.day))].sort();
    if (days.length < 3) return notEnough('There are too few dates to compare yet.');
    const gaps = days.slice(1).map((d, i) => (ms(d) - ms(days[i])) / DAY);
    const typicalGap = median(gaps);
    if (typicalGap > 45) return notEnough('This data is dated by quarter or year; a briefing needs dates by day, week or month.');
    // Weeks for data dated by day or week; months for monthly data — or when a
    // typical week has too few rows to compare (a staff list dated by hire date).
    const group = (g: 'week' | 'month') => {
        const keyOf = g === 'week' ? mondayOf : monthOf;
        const map = new Map<string, Period>();
        for (const { row, day } of dated) {
            const key = keyOf(day);
            const p = map.get(key) || { key, days: new Set<string>(), rows: [] };
            p.days.add(day); p.rows.push(row);
            map.set(key, p);
        }
        return map;
    };
    let grain: 'week' | 'month' = typicalGap <= 8 ? 'week' : 'month';
    let periods = group(grain);
    const volume = (map: Map<string, Period>) => median([...map.values()].map(p => p.rows.length));
    if (grain === 'week' && volume(periods) < 5) { grain = 'month'; periods = group('month'); }
    if (volume(periods) < 5) return notEnough(`There are only about ${Math.round(volume(periods))} rows a ${grain} — too few to compare one ${grain} with another.`, grain);
    const keys = [...periods.keys()].sort();
    const lastDay = days[days.length - 1];

    // Is the latest period full? For daily data, the days the business
    // normally has data for must all have come in.
    let latest = keys[keys.length - 1];
    const daily = typicalGap <= 1.5;
    if (daily) {
        if (grain === 'week') {
            const recentWeeks = keys.slice(-9, -1).map(k => periods.get(k)!);
            const usualDays = new Set<number>();
            for (let d = 0; d < 7; d++) if (recentWeeks.filter(w => [...w.days].some(x => weekday(x) === d)).length >= Math.max(1, recentWeeks.length / 2)) usualDays.add(d);
            const lastIndex = (weekday(lastDay) + 6) % 7; // Monday = 0
            if ([...usualDays].some(d => (d + 6) % 7 > lastIndex)) latest = keys[keys.length - 2];
        } else {
            const end = new Date(Date.UTC(Number(lastDay.slice(0, 4)), Number(lastDay.slice(5, 7)), 0)).getUTCDate();
            if (Number(lastDay.slice(8, 10)) < end - 2) latest = keys[keys.length - 2];
        }
    }
    const at = keys.indexOf(latest);
    const before = keys.slice(Math.max(0, at - (grain === 'week' ? 8 : 6)), at).map(k => periods.get(k)!);
    if (at < 0 || before.length < 2) return notEnough(`A briefing compares the latest full ${grain} with the ${grain}s before it; the data needs at least three full ${grain}s.`, grain);
    const current = periods.get(latest)!;
    const usual = before.slice(-4);

    // Measures
    const amount = mainAmount(dataset, shape);
    const unit = countUnit(shape, rows);
    const units = pluralWord(unit.word);
    const total = (ps: Record<string, any>[], col: string) => ps.reduce((t, r) => t + (toNumber(r[col]) ?? 0), 0);
    const countOf = (ps: Record<string, any>[]) => (unit.id ? new Set(ps.map(r => r[unit.id!]).filter(v => !isBlank(v)).map(String)).size : ps.length);
    const value = (ps: Record<string, any>[]) => (amount ? total(ps, amount.name) : countOf(ps));
    const mainLabel = amount ? amount.label : units;
    const fmtMain = (v: number) => (amount ? friendlyNumber(v, amount.symbol) : Math.round(v).toLocaleString('en-GB'));
    const isMoney = Boolean(amount && (amount.symbol || MONEY_NAME.test(amount.name)));
    const costLike = amount ? hasWord(amount.name, COST_WORDS) : false;
    const goodWhenUp = !costLike;

    const cur = value(current.rows);
    const history = before.map(p => value(p.rows));
    const usualValue = mean(usual.map(p => value(p.rows)));
    const swing = sd(history);
    const prev = history[history.length - 1];
    const vsUsual = usualValue ? (cur - usualValue) / Math.abs(usualValue) : 0;
    const vsPrev = prev ? (cur - prev) / Math.abs(prev) : 0;
    const unusual = Math.abs(vsUsual) >= 0.05 && (swing === 0 || Math.abs(cur - usualValue) >= 1.5 * swing);

    // Labels
    const start = latest;
    const endDay = grain === 'week' ? dayOf(ms(start) + 6 * DAY) : dayOf(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 0));
    const todayDay = today.toISOString().slice(0, 10);
    const lastCalendar = grain === 'week' ? dayOf(ms(mondayOf(todayDay)) - 7 * DAY) : monthOf(dayOf(ms(monthOf(todayDay)) - DAY));
    const sameMonth = start.slice(0, 7) === endDay.slice(0, 7);
    const range = grain === 'week'
        ? (sameMonth ? `${Number(start.slice(8, 10))}–${fmtDay(endDay, true)}` : `${fmtDay(start)} – ${fmtDay(endDay, true)}`)
        : new Date(ms(start)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const isLastCalendar = latest === lastCalendar;
    const periodLabel = isLastCalendar ? `Last ${grain} · ${range}` : `${range} · the latest full ${grain} in your data`;
    const periodWord = isLastCalendar ? `last ${grain}` : (grain === 'week' ? `in the week of ${range}` : `in ${range}`);
    const usualWord = `a usual ${grain}`;

    // Figures
    const figures: BriefingFigure[] = [];
    const changeText = (now: number, was: number) => {
        if (!was) return undefined;
        const ratio = (now - was) / Math.abs(was);
        if (Math.abs(ratio) < 0.005) return `level with ${usualWord}`;
        return `${now >= was ? '+' : '−'}${Math.abs(ratio) > 9.99 ? '999%+' : pctText(ratio)} vs ${usualWord}`;
    };
    const toneFor = (now: number, was: number, goodIsUp = true): BriefingTone => {
        if (!was || Math.abs(now - was) / Math.abs(was) < 0.05) return 'neutral';
        if (amount && !isMoney && goodIsUp === goodWhenUp) return 'neutral'; // more hours worked is neither good nor bad
        return (now > was) === goodIsUp ? 'good' : 'bad';
    };
    // The main figure is only coloured when the change is beyond the usual swing.
    figures.push({ label: capital(mainLabel), value: fmtMain(cur), change: changeText(cur, usualValue), tone: !unusual || (shape.countStory && !amount) ? 'neutral' : toneFor(cur, usualValue, goodWhenUp) });
    const curCount = countOf(current.rows), usualCount = mean(usual.map(p => countOf(p.rows)));
    const showCount = Boolean(amount) && !unit.generic;
    if (showCount) figures.push({ label: capital(units), value: Math.round(curCount).toLocaleString('en-GB'), change: changeText(curCount, usualCount), tone: toneFor(curCount, usualCount) });
    // Average per order: lines grouped by an order number, or one row per order.
    if (showCount && isMoney && curCount > 0 && usualCount > 0) {
        const avgNow = cur / curCount, avgUsual = usualValue / usualCount;
        figures.push({ label: `Average per ${unit.word}`, value: friendlyNumber(avgNow, amount!.symbol), change: changeText(avgNow, avgUsual), tone: toneFor(avgNow, avgUsual, goodWhenUp) });
    }

    // The tracked outcome's rate: for records data, or a problem outcome in sales
    // data (returns, refunds, cancellations).
    const findings: BriefingFinding[] = [];
    const outcome = shape.outcome && (shape.countStory || hasWord(shape.outcome, /^(returned|return|returns|refund|refunded|cancelled|canceled|cancel|churn|churned|complaint|failed|declined|void|voided|late|defect|defective)$/)) ? shape.outcome : undefined;
    if (outcome) {
        const focus = outcomeFocus(outcome);
        const rateOf = (ps: Record<string, any>[]) => {
            let n = 0, hit = 0;
            for (const r of ps) { const side = yesNoSide(r[outcome]); if (side === null) continue; n++; if (side === focus.badIsYes) hit++; }
            return { n, rate: n ? hit / n : 0 };
        };
        const now = rateOf(current.rows);
        const was = rateOf(usual.flatMap(p => p.rows));
        const label = `% ${focus.focusWords}`;
        if (now.n) {
            figures.push({ label: capital(label), value: `${Math.round(now.rate * 1000) / 10}%`, change: was.n ? `${now.rate >= was.rate ? '+' : '−'}${Math.round(Math.abs(now.rate - was.rate) * 1000) / 10} pts vs ${usualWord}` : undefined, tone: Math.abs(now.rate - was.rate) < 0.01 ? 'neutral' : now.rate > was.rate ? 'bad' : 'good' });
            // Outside what chance would give for a period of this size, around the usual rate.
            const band = wilsonInterval(was.rate, now.n);
            if (was.n && (now.rate < band.low || now.rate > band.high)) {
                findings.push({
                    kind: 'rate', tone: now.rate > was.rate ? 'bad' : 'good',
                    text: `${capital(label)} was ${Math.round(now.rate * 1000) / 10}% ${periodWord}, against ${Math.round(was.rate * 1000) / 10}% in ${usualWord} — more than chance would explain.`,
                    check: now.rate > was.rate ? `Look at the ${units} behind it: which days, places or groups changed.` : `Find out what went well ${periodWord} so it can be repeated.`,
                    ask: `Which groups changed most in ${label} ${periodWord}, compared with the ${grain}s before?`,
                });
            }
        }
    }

    // A label that changes with the calendar (the sheet a month's rows came from, a
    // "quarter" or "season" column) moves with time itself, so it explains nothing.
    const isPeriodLabel = (column: string) => {
        const spans = new Map<string, { from: string; to: string }>();
        for (const r of rows) {
            if (isBlank(r[column]) || isBlank(r[dateCol])) continue;
            const day = String(r[dateCol]).slice(0, 10);
            const span = spans.get(String(r[column]));
            if (!span) spans.set(String(r[column]), { from: day, to: day });
            else { if (day < span.from) span.from = day; if (day > span.to) span.to = day; }
        }
        if (spans.size < 2) return false;
        const ordered = [...spans.values()].sort((a, b) => a.from.localeCompare(b.from));
        return ordered.every((span, i) => i === 0 || span.from > ordered[i - 1].to);
    };

    // Columns to explain a change by: not the date, the outcome, the order ID,
    // statuses, clock times, or columns with too many values to read.
    const categories = shape.categories.filter(c => c !== dateCol && c !== outcome && c !== shape.outcome && c !== unit.id && categoryKind(c) !== 'status').filter(c => {
        const values = rows.slice(0, 2000).map(r => r[c]).filter(v => !isBlank(v)).map(String);
        if (values.length && values.filter(v => /^\d{1,2}:\d{2}(:\d{2})?$/.test(v.trim())).length >= values.length * 0.8) return false;
        const distinct = new Set(rows.map(r => r[c]).filter(v => !isBlank(v)).map(String)).size;
        return distinct >= 2 && distinct <= 60 && !isPeriodLabel(c);
    });
    const byCategory = (ps: Period[], col: string) => {
        const m = new Map<string, number>();
        for (const p of ps) {
            const groups = new Map<string, Record<string, any>[]>();
            for (const r of p.rows) { if (isBlank(r[col])) continue; const k = String(r[col]); const list = groups.get(k); if (list) list.push(r); else groups.set(k, [r]); }
            for (const [k, rs] of groups) m.set(k, (m.get(k) || 0) + value(rs) / ps.length);
        }
        return m;
    };
    const delta = cur - usualValue;
    const material = Math.max(Math.abs(usualValue) * 0.1, 0);
    let explained: { col: string; key: string; change: number; now: number; was: number; share: number } | null = null;
    const movers: { col: string; key: string; change: number; now: number; was: number }[] = [];
    for (const col of categories) {
        const nowBy = byCategory([current], col), wasBy = byCategory(usual, col);
        for (const key of new Set([...nowBy.keys(), ...wasBy.keys()])) {
            const n = nowBy.get(key) || 0, w = wasBy.get(key) || 0;
            const change = n - w;
            if (unusual && delta && Math.sign(change) === Math.sign(delta) && !(Math.abs(w) >= Math.abs(usualValue) * 0.9 && Math.abs(n) >= Math.abs(cur) * 0.9)) {
                const share = change / delta;
                if (share >= 0.4 && (!explained || share > explained.share)) explained = { col, key, change, now: n, was: w, share };
            }
            const almostAll = Math.abs(w) >= Math.abs(usualValue) * 0.9 && Math.abs(n) >= Math.abs(cur) * 0.9;
            if (!almostAll && w > 0 && Math.abs(change / w) >= 0.3 && Math.abs(change) >= material) movers.push({ col, key, change, now: n, was: w });
        }
    }
    const signed = (v: number) => `${v >= 0 ? '+' : '−'}${fmtMain(Math.abs(v))}`;
    if (explained) {
        const e = explained;
        const down = e.change < 0;
        findings.push({
            kind: 'driver', tone: down === goodWhenUp ? 'bad' : 'good',
            text: `${e.key} (${plainName(e.col)}) accounts for ${signed(e.change)} of the ${signed(delta)} change: ${fmtMain(e.now)}, ${againstUsual(e.now, e.was, usualWord, fmtMain)}.`,
            check: adviceFor(categoryKind(e.col), e.key, down === goodWhenUp, periodWord),
            ask: `Why did ${mainLabel} for ${e.key} ${down ? 'fall' : 'rise'} ${periodWord}?`,
        });
    }
    movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    for (const m of movers.filter(m => !explained || m.key !== explained.key).slice(0, unusual ? 1 : 2)) {
        const down = m.change < 0;
        findings.push({
            kind: 'mover', tone: down === goodWhenUp ? 'bad' : 'good',
            text: `${m.key} (${plainName(m.col)}): ${fmtMain(m.now)} ${periodWord}, ${againstUsual(m.now, m.was, usualWord, fmtMain)}.`,
            check: adviceFor(categoryKind(m.col), m.key, down === goodWhenUp, periodWord),
            ask: `How did ${mainLabel} for ${m.key} change over the last few ${grain}s?`,
        });
    }

    // The day furthest from a usual one — only for businesses with data on most
    // of their trading days (a bank statement's quiet days are normal).
    if (grain === 'week' && daily) {
        const weeks = usual.length;
        const regular = [0, 1, 2, 3, 4, 5, 6].filter(d => usual.filter(w => [...w.days].some(x => weekday(x) === d)).length >= Math.ceil(weeks * 0.75));
        const tradingDaysCovered = regular.length >= 3;
        if (tradingDaysCovered) {
            const totalOn = (p: Period, d: string) => value(p.rows.filter(r => toDay(r[dateCol]) === d));
            let worst: { day: string; now: number; was: number; ratio: number } | null = null;
            for (const day of current.days) {
                if (!regular.includes(weekday(day))) continue;
                const sameDays = usual.flatMap(p => [...p.days].filter(d => weekday(d) === weekday(day)).map(d => totalOn(p, d)));
                if (sameDays.length < 2) continue;
                const was = mean(sameDays), now = totalOn(current, day);
                if (!was) continue;
                const ratio = (now - was) / Math.abs(was);
                if (Math.abs(ratio) >= 0.25 && Math.abs(now - was) >= 1.5 * sd(sameDays) && Math.abs(now - was) >= material / 2 && (!worst || Math.abs(ratio) > Math.abs(worst.ratio))) worst = { day, now, was, ratio };
            }
            if (worst) {
                const name = WEEKDAYS[weekday(worst.day)];
                const down = worst.ratio < 0;
                findings.push({
                    kind: 'weekday', tone: down === goodWhenUp ? 'bad' : 'good',
                    text: `${name} ${fmtDay(worst.day)}: ${fmtMain(worst.now)}, ${againstUsual(worst.now, worst.was, `a usual ${name}`, fmtMain)}.`,
                    check: down === goodWhenUp ? `Was anything different on ${name} — a closure, fewer staff, an event or the weather?` : `What was different on ${name}? Worth repeating if it was something you did.`,
                    ask: `How did ${mainLabel} on ${name} ${fmtDay(worst.day, true)} compare with other ${name}s, and what was different?`,
                });
            }
        }
    }

    // Three or more falls or rises in a row.
    const series = [...history, cur];
    let run = 0;
    for (let i = series.length - 1; i > 0; i--) {
        const step = Math.sign(series[i] - series[i - 1]);
        if (step === 0 || (run !== 0 && step !== Math.sign(run))) break;
        run += step;
    }
    if (Math.abs(run) >= 3) {
        const down = run < 0;
        const from = series[series.length - 1 - Math.abs(run)];
        const ordinal = ['', '', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'][Math.abs(run)] || `${Math.abs(run)}th`;
        findings.push({
            kind: 'streak', tone: down === goodWhenUp ? 'bad' : 'good',
            text: `The ${ordinal} ${grain} in a row that ${mainLabel} ${down ? 'fell' : 'rose'}: from ${fmtMain(from)} to ${fmtMain(cur)}.`,
            check: down === goodWhenUp ? `A steady slide is easier to fix early: compare these ${grain}s by what you sell, where and when.` : undefined,
            ask: `Show ${mainLabel} by ${grain} for the last ${Math.abs(run) + 3} ${grain}s, and what changed most.`,
        });
    }

    // Things that usually sell but didn't (only for columns of things sold).
    const offerCol = categories.filter(c => categoryKind(c) === 'offer').sort((a, b) => new Set(rows.map(r => r[b])).size - new Set(rows.map(r => r[a])).size)[0];
    if (offerCol) {
        const nowBy = byCategory([current], offerCol);
        const steady: [string, number][] = [];
        for (const key of new Set(usual.flatMap(p => p.rows.map(r => r[offerCol])).filter(v => !isBlank(v)).map(String))) {
            const per = usual.map(p => value(p.rows.filter(r => String(r[offerCol]) === key)));
            if (per.filter(v => v > 0).length >= Math.max(2, usual.length - 1)) steady.push([key, mean(per)]);
        }
        for (const [key, was] of steady.filter(([key]) => !nowBy.get(key)).sort((a, b) => b[1] - a[1]).slice(0, 2)) {
            findings.push({
                kind: 'stopped', tone: 'bad',
                text: `${key} had no ${mainLabel} ${periodWord}, after about ${fmtMain(was)} in ${usualWord}.`,
                check: `Check whether ${key} is out of stock, off sale, or recorded under a different name.`,
                ask: `When did ${key} last sell, and how much did it bring in each ${grain} before that?`,
            });
        }
    }

    const order: Record<BriefingFinding['kind'], number> = { driver: 0, rate: 1, stopped: 2, weekday: 3, streak: 4, mover: 5, started: 6 };
    findings.sort((a, b) => order[a.kind] - order[b.kind]);

    // Headline
    const from = showCount ? ` from ${Math.round(curCount).toLocaleString('en-GB')} ${curCount === 1 ? unit.word : units}` : '';
    const what = amount ? `${mainLabel} came to ${fmtMain(cur)}${from}` : `there were ${fmtMain(cur)} ${mainLabel}`;
    const vs = !usualValue ? '' : Math.abs(vsUsual) < 0.005 ? `level with ${usualWord}` : `${Math.round(Math.abs(vsUsual) * 100)}% ${cur >= usualValue ? 'above' : 'below'} ${usualWord}`;
    // A big change that is still inside the data's own normal swing is said as such.
    const avgWord = `the average ${grain}`;
    let headline = !unusual
        ? (Math.abs(vsUsual) < 0.1
            ? `${capital(periodWord)}, ${what} — a normal ${grain}${vs ? ` (${vs})` : ''}.`
            : `${capital(periodWord)}, ${what} — ${Math.round(Math.abs(vsUsual) * 100)}% ${cur >= usualValue ? 'above' : 'below'} ${avgWord}, but your ${grain}s often swing this much, so it isn't unusual on its own.`)
        : `${capital(periodWord)}, ${what} — ${vs}${explained ? `, mostly because of ${explained.key}` : ''}.`;
    if (unusual && prev && Math.abs(vsPrev) >= 0.05) headline += ` That is ${pctText(vsPrev)} ${cur >= prev ? 'up' : 'down'} on the ${grain} before.`;

    const ageDays = (ms(todayDay) - ms(lastDay)) / DAY;
    const stale = ageDays > (grain === 'week' ? 13 : 45)
        ? `Your data stops on ${fmtDay(lastDay, true)}. Refresh the connection or add newer data to see ${grain === 'week' ? 'last week' : 'last month'}.`
        : undefined;

    return { status: 'ready', grain, periodKey: latest, periodLabel, headline, figures, findings: findings.slice(0, 5), dataUntil: lastDay, stale };
}
