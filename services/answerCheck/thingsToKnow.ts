/**
 * "Things to know" about an answer whose figures are right: what a person
 * should weigh before acting on it. Every rule works from the query's own
 * structure and the data's own values — nothing about a particular file:
 *
 *   1. Small groups — a rate worked out from few records is uncertain. Its
 *      95% range (Wilson) is computed from the number of records actually
 *      behind that figure; when the range is wider than 30 points the
 *      answer says so ("25% from 4 records — could be anywhere from 5% to
 *      70%"). Averages of fewer than 5 records are named too.
 *   2. Values that can't be right — values the query reads that are
 *      impossible by the column's meaning or wildly out of line
 *      (utils/plausibility). The query is worked out again without them and
 *      the figures that move are shown, before → after.
 *   3. Catch-all labels — a CASE … ELSE that sweeps blanks or unexpected
 *      values into a label ("No") is named, with what it swept in.
 */
import type { Expr, Query, Select } from './sqlParser';
import { evaluate, toNum, type EvalResult, type Value } from './sqlEval';
import { RATE_NAME } from '../../utils/answerGuard';
import { rateTooUncertain, suspectValues } from '../../utils/plausibility';

const words = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const fmt = (n: number) => n.toLocaleString('en-GB', { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });

function selects(q: Query): Select[] {
    const out: Select[] = [];
    const visit = (query: Query) => {
        query.ctes.forEach(c => visit(c.q));
        for (const s of [query.body, ...query.unions.map(u => u.s)]) {
            out.push(s);
            const fromQueries = (ref: Select['from']): void => { if (!ref) return; if (ref.k === 'sub') visit(ref.q); if (ref.k === 'join') { fromQueries(ref.left); fromQueries(ref.right); } };
            fromQueries(s.from);
        }
    };
    visit(q);
    return out;
}
function walk(e: Expr | undefined, fn: (e: Expr) => void): void {
    if (!e) return;
    fn(e);
    switch (e.k) {
        case 'unary': case 'isnull': case 'cast': walk(e.e, fn); break;
        case 'bin': walk(e.l, fn); walk(e.r, fn); break;
        case 'in': walk(e.e, fn); e.list?.forEach(x => walk(x, fn)); break;
        case 'between': walk(e.e, fn); walk(e.lo, fn); walk(e.hi, fn); break;
        case 'like': walk(e.e, fn); walk(e.pat, fn); break;
        case 'case': walk(e.operand, fn); e.whens.forEach(w => { walk(w.when, fn); walk(w.then, fn); }); walk(e.else, fn); break;
        case 'func': e.args.forEach(x => walk(x, fn)); walk(e.filter, fn); e.over?.partition.forEach(x => walk(x, fn)); e.over?.order.forEach(o => walk(o.e, fn)); break;
    }
}
function allExprs(s: Select): Expr[] {
    return [...s.items.map(i => i.e), s.where, s.having, s.qualify, ...(Array.isArray(s.groupBy) ? s.groupBy : [])].filter(Boolean) as Expr[];
}
const strip = (e: Expr): Expr => {
    if (e.k === 'func' && (e.name === 'ROUND' || e.name === 'COALESCE') && e.args[0]) return strip(e.args[0]);
    if (e.k === 'cast') return strip(e.e);
    if (e.k === 'bin' && e.op === '*' && e.l.k === 'lit') return strip(e.r);
    if (e.k === 'bin' && e.op === '*' && e.r.k === 'lit') return strip(e.l);
    return e;
};
const isAverage = (e: Expr) => { const x = strip(e); return x.k === 'func' && ['AVG', 'MEAN', 'MEDIAN'].includes(x.name) && !x.over; };
const isRatio = (e: Expr) => strip(e).k === 'bin' && (strip(e) as any).op === '/';

export interface ThingsInput {
    q: Query;
    expected: EvalResult;
    /** Shown row → row of `expected` (or of the full result when a LIMIT cut through ties). */
    matchIndex: (number | -1)[];
    pool: EvalResult;
    shown: Value[][];
    data: Record<string, any>[];
    recordWord?: string;
    budgetMs: number;
    otherTables?: string[];
    /** The other tables the query may read, by name. */
    tables?: Record<string, Record<string, any>[]>;
}

export function thingsToKnow(input: ThingsInput): string[] {
    const out: string[] = [];
    try { out.push(...smallGroups(input)); } catch { /* best effort */ }
    try { out.push(...impossibleValues(input)); } catch { /* best effort */ }
    try { out.push(...catchAllLabels(input)); } catch { /* best effort */ }
    return out;
}

// ── 1. Small groups ──
function smallGroups({ q, pool, matchIndex, shown, recordWord }: ThingsInput): string[] {
    const cols = pool.cols;
    const items = q.body.items;
    const records = (n: number) => `${n.toLocaleString('en-GB')} ${recordWord || 'record'}${n === 1 ? '' : 's'}`;
    const textCol = cols.map((_, c) => shown.some(r => r[c] !== null && typeof r[c] !== 'number'));
    const label = (row: Value[]) => cols.map((_, c) => (textCol[c] && row[c] !== null ? String(row[c]) : null)).filter(Boolean).join(' · ') || 'The answer';
    const prefix = (row: Value[]) => { const parts = cols.map((_, c) => (textCol[c] && row[c] !== null ? String(row[c]) : null)).filter(Boolean); return parts.slice(0, Math.max(1, parts.length - 1)).join(' · '); };
    const uncertain: { text: string; key: string }[] = [];
    const fewAverages: { text: string; key: string }[] = [];
    cols.forEach((name, c) => {
        const expr = items[c]?.e;
        const values = shown.map(r => r[c]).filter((v): v is number => typeof v === 'number');
        if (!values.length) return;
        const rateLike = (RATE_NAME.test(name) || (expr && isRatio(expr))) && values.every(v => v >= 0 && v <= 100) && !/(change|growth|diff|delta|vs|increase|decrease|lift)/i.test(name);
        const scale = /(pct|percent|percentage)/i.test(name) || values.some(v => v > 1) ? 100 : 1;
        const averageLike = (expr && isAverage(expr)) || /(^|_)(avg|average|mean|median)($|_)/i.test(name);
        shown.forEach((row, i) => {
            const j = matchIndex[i];
            const v = row[c];
            if (j < 0 || typeof v !== 'number') return;
            const n = pool.cellBase[j]?.[c] || 0;
            if (n <= 0) return;
            if (rateLike) {
                const range = rateTooUncertain(v / scale, n);
                if (range) uncertain.push({ key: `${prefix(row)}|${n}`, text: `${label(row)}: ${scale === 100 ? `${fmt(v)}%` : pct(v)} is worked out from ${records(n)}, so the real figure could be anywhere from ${pct(range.low)} to ${pct(range.high)}.` });
            } else if (averageLike && n < 5) {
                fewAverages.push({ key: `${label(row)}|${n}`, text: `${label(row)}: the ${words(name)} is an average of only ${records(n)}.` });
            }
        });
    });
    const dedupe = (list: { text: string; key: string }[]) => { const seen = new Set<string>(); return list.filter(x => (seen.has(x.key) ? false : (seen.add(x.key), true))); };
    const notes: string[] = [];
    const u = dedupe(uncertain), a = dedupe(fewAverages);
    if (u.length) notes.push(...u.slice(0, 2).map(x => x.text), ...(u.length > 2 ? [`${u.length - 2} more ${u.length - 2 === 1 ? 'figure is' : 'figures are'} worked out from too few ${recordWord || 'record'}s to compare reliably.`] : []));
    if (a.length) notes.push(...a.slice(0, 2).map(x => x.text));
    return notes;
}

// ── 2. Values that can't be right ──
function impossibleValues({ q, pool, data, budgetMs, otherTables, tables, shown, matchIndex }: ThingsInput): string[] {
    if (!data.length) return [];
    const dataCols = new Map(Object.keys(data[0]).map(c => [c.toLowerCase(), c]));
    const used = new Set<string>();
    for (const s of selects(q)) for (const e of allExprs(s)) walk(e, x => { if (x.k === 'col' && dataCols.has(x.name.toLowerCase())) used.add(dataCols.get(x.name.toLowerCase())!); });
    const bad = new Map<number, { column: string; value: number; why: string }>();
    for (const column of used) {
        for (const s of suspectValues(data.map(r => r[column]), column)) if (!bad.has(s.row)) bad.set(s.row, { column, value: s.value, why: s.why });
    }
    if (!bad.size) return [];
    // Only the impossible cell is left out (as a blank); the rest of its row still counts everywhere else.
    const without = data.map((row, i) => { const b = bad.get(i); return b ? { ...row, [b.column]: null } : row; });
    const again = evaluate(q, { ...tables, data: without }, budgetMs, otherTables);
    // Line the two results up by their labels and list the figures that move.
    const textCol = pool.cols.map((_, c) => shown.some(r => r[c] !== null && typeof r[c] !== 'number'));
    const key = (row: Value[]) => pool.cols.map((_, c) => (textCol[c] ? String(row[c]) : '')).join('\u0001');
    const later = new Map(again.rows.map(r => [key(r), r]));
    const moves: string[] = [];
    shown.forEach((row, i) => {
        if (matchIndex[i] < 0) return;
        const after = later.get(key(row));
        if (!after) return;
        pool.cols.forEach((name, c) => {
            const a = toNum(row[c]), b = toNum(after[c]);
            if (textCol[c] || a === null || b === null || Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 1e-9)) return;
            const where = pool.cols.map((_, k) => (textCol[k] && row[k] !== null ? String(row[k]) : null)).filter(Boolean).join(' · ');
            const unit = /(pct|percent|percentage)/i.test(name) ? '%' : '';
            const label = words(name.replace(/_(pct|percent|percentage)$/i, ''));
            moves.push(`${where ? `${where}: ` : ''}${label} ${fmt(a)}${unit} → ${fmt(b)}${unit}`);
        });
    });
    if (!moves.length) return [];
    const list = [...bad.values()];
    const byColumn = new Map<string, typeof list>();
    for (const b of list) byColumn.set(b.column, [...(byColumn.get(b.column) || []), b]);
    const what = [...byColumn.entries()].map(([column, items]) => `${[...new Set(items.map(x => fmt(x.value)))].slice(0, 3).join(', ')} in ${words(column)} (${items[0].why})`).join('; ');
    return [`This answer includes ${list.length === 1 ? 'a value that can\'t be right' : `${list.length} values that can't be right`}: ${what}. Without ${list.length === 1 ? 'it' : 'them'}: ${moves.slice(0, 3).join('; ')}${moves.length > 3 ? `; and ${moves.length - 3} more` : ''}.`];
}

// ── 3. Catch-all labels ──
function catchAllLabels({ q, data }: ThingsInput): string[] {
    if (!data.length) return [];
    const dataCols = new Map(Object.keys(data[0]).map(c => [c.toLowerCase(), c]));
    const notes: string[] = [];
    const seen = new Set<string>();
    const colOf = (e: Expr): { name: string; folded: boolean } | null => {
        if (e.k === 'col' && dataCols.has(e.name.toLowerCase())) return { name: dataCols.get(e.name.toLowerCase())!, folded: false };
        if (e.k === 'func' && ['LOWER', 'UPPER', 'TRIM', 'LCASE', 'UCASE'].includes(e.name) && e.args[0]) { const c = colOf(e.args[0]); return c ? { ...c, folded: true } : null; }
        if (e.k === 'cast') return colOf(e.e);
        return null;
    };
    const litOf = (e: Expr): Value | undefined => (e.k === 'lit' ? e.v : e.k === 'func' && ['LOWER', 'UPPER', 'TRIM'].includes(e.name) && e.args[0]?.k === 'lit' ? e.args[0].v : undefined);
    for (const s of selects(q)) for (const root of allExprs(s)) walk(root, e => {
        if (e.k !== 'case' || !e.else) return;
        // Which column the WHENs test, and the values they name.
        let column: { name: string; folded: boolean } | null = null;
        const named: Value[] = [];
        let boolTest = false;
        for (const w of e.whens) {
            const cond: Expr = e.operand ? { k: 'bin', op: '=', l: e.operand, r: w.when } : w.when;
            let c: { name: string; folded: boolean } | null = null;
            if (cond.k === 'col' || (cond.k === 'unary' && cond.op === 'NOT' && cond.e.k === 'col')) { c = colOf(cond.k === 'col' ? cond : (cond as any).e); boolTest = true; named.push(cond.k === 'col'); }
            else if (cond.k === 'bin' && cond.op === '=') { c = colOf(cond.l) || colOf(cond.r); const lit = litOf(cond.l) ?? litOf(cond.r); if (lit !== undefined) named.push(lit); else c = null; }
            else if (cond.k === 'in' && cond.list && !cond.not) { c = colOf(cond.e); cond.list.forEach(x => { const lit = litOf(x); if (lit !== undefined) named.push(lit); }); }
            if (!c || (column && column.name !== c.name)) return;
            column = c;
        }
        if (!column) return;
        const col = column as { name: string; folded: boolean };
        const norm = (v: unknown) => (typeof v === 'string' ? (col.folded ? v.trim().toLowerCase() : v) : v);
        const namedSet = new Set(named.map(v => String(norm(v))));
        const swept = new Map<string, number>();
        let blanks = 0;
        for (const row of data) {
            const v = row[col.name];
            if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) { blanks++; continue; }
            if (boolTest) { if (typeof v === 'boolean' || /^(true|false)$/i.test(String(v))) continue; }
            const k = String(norm(typeof v === 'boolean' ? v : v));
            if (namedSet.has(k)) continue;
            swept.set(String(v), (swept.get(String(v)) || 0) + 1);
        }
        const elseLabel = e.else.k === 'lit' && e.else.v !== null ? `"${e.else.v}"` : 'the other group';
        const sorted = [...swept.entries()].sort((x, y) => y[1] - x[1]);
        const leftover = sorted.reduce((t, [, n]) => t + n, 0);
        // ELSE meaning "every other store / department" is by design. Only a
        // two-sided column — ELSE stands for one opposite value ("no"), at
        // least 80% of what it catches — can have things slip in by mistake.
        const twoSided = boolTest || (sorted.length > 0 && sorted[0][1] / leftover >= 0.8);
        if (!twoSided) return;
        const extra = boolTest ? sorted : sorted.slice(1);
        const parts: string[] = [];
        if (blanks) parts.push(`${blanks.toLocaleString('en-GB')} blank value${blanks === 1 ? '' : 's'}`);
        if (extra.length) parts.push(extra.slice(0, 3).map(([v, n]) => `"${v}" (${n.toLocaleString('en-GB')})`).join(', '));
        const key = `${col.name}|${elseLabel}`;
        if (!parts.length || seen.has(key)) return;
        seen.add(key);
        notes.push(e.else.k === 'lit' && typeof e.else.v === 'string'
            ? `${elseLabel} also counts ${parts.join(' and ')} of ${words(col.name)}: the question puts anything it doesn't name into ${elseLabel}.`
            : `${parts.join(' and ')} of ${words(col.name)} ${blanks + extra.reduce((t, [, n]) => t + n, 0) === 1 ? 'is' : 'are'} counted with the rows that don't match: the question puts anything it doesn't name there.`);
    });
    return notes.slice(0, 2);
}
