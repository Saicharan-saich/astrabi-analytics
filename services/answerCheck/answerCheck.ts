/**
 * The answer check: every answer is worked out a second time, independently,
 * from the cleaned data in the browser, and compared figure by figure.
 *
 * Two layers:
 *   1. Recompute — the query is read by our own SQL reader (sqlParser) and
 *      worked out by our own calculator (sqlEval), sharing nothing with DuckDB
 *      or the Builder's engine. Every figure shown must match.
 *   2. Checks that need no recompute — text values the query filters on exist
 *      in the data (with the nearest real values when they don't), rates stay
 *      between 0 and 100, how many rows the answer is based on, and what share
 *      of the whole a "top N" covers.
 *
 * The check never guesses: what it cannot work out is reported as "partly
 * checked" with the reason; where DuckDB could legitimately pick either of two
 * tied rows the check accepts either. Nothing leaves the browser.
 */
import { parseSQL, Unsupported, type Expr, type Query } from './sqlParser';
import { evaluate, SqlDate, toNum, type EvalResult, type Value } from './sqlEval';
import { RATE_NAME } from '../../utils/answerGuard';

export type AnswerCheckStatus = 'verified' | 'warning' | 'mismatch' | 'partial';

export interface FigureDifference { where: string; column: string; shown: string; recomputed: string }
export interface FilterValueCheck { column: string; value: string; matches: number; suggestions: string[] }

export interface AnswerCheck {
    status: AnswerCheckStatus;
    /** One plain sentence for the strip under the answer. */
    headline: string;
    figuresChecked: number;
    figuresMatched: number;
    differences: FigureDifference[];
    filterValues: FilterValueCheck[];
    /** "Based on 5,812 of 6,000 rows." */
    coverage?: string;
    /** What the query counted, in words, worked out from the query itself. */
    counted?: string;
    /** Other plain notes (top-N share, ties, ranges). */
    notes: string[];
    /** Why the recompute could not run, when status is partial. */
    reason?: string;
    ms: number;
}

export interface AnswerCheckInput {
    sql: string;
    /** What the query returned (before any display relabelling). */
    rows: Record<string, any>[];
    /** The cleaned data the answer was computed from. */
    data: Record<string, any>[];
    /** Word for one row ("order", "appointment"), when known. */
    recordWord?: string;
    budgetMs?: number;
    /** Read the shown rows by the query's column names (the Builder's rows carry extra keys). */
    matchByName?: boolean;
    /** Other uploaded tables: a query that reads them is only partly checked. */
    otherTables?: string[];
}

const words = (name: string) => name.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
const fmt = (n: number) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-GB') : Number(n.toFixed(Math.abs(n) < 1 ? 4 : 2)).toLocaleString('en-GB', { maximumFractionDigits: 4 }));
const plural = (n: number, word: string) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

// ── Comparing one figure ──
function normalise(v: any): Value {
    if (v === undefined || v === null) return null;
    if (v instanceof SqlDate) return v.toString();
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v;
    if (Array.isArray(v) || typeof v === 'object') return JSON.stringify(v);
    return String(v);
}
function decimals(n: number): number {
    if (!Number.isFinite(n) || Number.isInteger(n)) return 0;
    const s = String(n);
    if (/e/i.test(s)) return 10;
    return (s.split('.')[1] || '').length;
}
/** How a blank group can be labelled on screen. */
const BLANK_LABEL = /^(unknown|\(blank\)|blank|\(empty\)|not set|—|-|)$/i;
export function sameFigure(shown: Value, recomputed: Value): boolean {
    if (recomputed === null && typeof shown === 'string' && BLANK_LABEL.test(shown.trim())) return true;
    if (shown === null || recomputed === null) return shown === recomputed;
    const a = typeof shown === 'number' ? shown : typeof shown === 'boolean' ? null : toNum(shown);
    const b = typeof recomputed === 'number' ? recomputed : typeof recomputed === 'boolean' ? null : toNum(recomputed);
    if (a !== null && b !== null && (typeof shown === 'number' || typeof recomputed === 'number')) {
        const diff = Math.abs(a - b);
        if (diff <= Math.max(1e-9, 1e-7 * Math.max(Math.abs(a), Math.abs(b)))) return true;
        // A figure rounded to k places may differ by one unit in the last place
        // (20.325 is just below or above the half, depending on the engine).
        const k = Math.min(Math.max(decimals(a), decimals(b)), 6);
        return k >= 1 && k <= 4 && diff <= Math.pow(10, -k) * 1.0001;
    }
    if (typeof shown === 'boolean' || typeof recomputed === 'boolean') return String(shown).toLowerCase() === String(recomputed).toLowerCase();
    const text = (v: Value) => String(v).replace(/^(-?\d+)\.0$/, '$1').replace(/^(\d{4}-\d{2}-\d{2})[ T]00:00:00(\.000)?Z?$/, '$1').replace('T', ' ');
    return text(shown) === text(recomputed);
}
const isFigure = (v: Value) => typeof v === 'number';
const show = (v: Value) => (v === null ? 'blank' : typeof v === 'number' ? fmt(v) : String(v));

/** Compare what was shown with what was recomputed: every row of one must be a row of the other. */
function compareRows(shown: Value[][], expected: EvalResult, full?: EvalResult): { checked: number; matched: number; differences: FigureDifference[]; rowCountNote?: string; zeroForBlank: number } {
    const cols = expected.cols;
    const differences: FigureDifference[] = [];
    let checked = 0, matched = 0, zeroForBlank = 0;
    // A 0 drawn where there was nothing to add up (no values in that group) is a display choice, not a wrong figure.
    const blankAsZero = (a: Value, b: Value) => (a === 0 && b === null) || (a === null && b === 0);
    const textCols = cols.map((_, i) => expected.rows.some(r => r[i] !== null && !isFigure(r[i])) || shown.some(r => r[i] !== null && typeof r[i] !== 'number'));
    const label = (row: Value[]) => {
        const parts = cols.map((c, i) => (textCols[i] && row[i] !== null ? String(row[i]) : null)).filter(Boolean);
        return parts.length ? parts.join(' · ') : 'the answer';
    };
    const pool = (full || expected).rows.slice();
    const used = new Set<number>();
    const keyMatch = (a: Value[], b: Value[]) => cols.every((_, i) => !textCols[i] || sameFigure(a[i], b[i]));
    shown.forEach((row, n) => {
        const figures = row.filter(isFigure).length;
        checked += figures;
        // An exact row first; then the row with the same labels; then the same position.
        let j = pool.findIndex((cand, i) => !used.has(i) && cand.every((v, c) => sameFigure(row[c], v) || blankAsZero(row[c], v)));
        if (j >= 0) zeroForBlank += pool[j].filter((v, c) => !sameFigure(row[c], v) && blankAsZero(row[c], v)).length;
        if (j >= 0) { used.add(j); matched += figures; return; }
        j = textCols.some(Boolean) ? pool.findIndex((cand, i) => !used.has(i) && keyMatch(row, cand)) : (!used.has(n) && n < pool.length ? n : -1);
        if (j < 0) {
            differences.push({ where: label(row), column: '', shown: 'this row', recomputed: 'no such row in a fresh calculation' });
            return;
        }
        used.add(j);
        row.forEach((v, c) => {
            if (!isFigure(v) && !isFigure(pool[j][c])) {
                if (!sameFigure(v, pool[j][c])) differences.push({ where: label(row), column: words(cols[c]), shown: show(v), recomputed: show(pool[j][c]) });
                return;
            }
            if (sameFigure(v, pool[j][c])) matched++;
            else if (blankAsZero(v, pool[j][c])) { matched++; zeroForBlank++; }
            else differences.push({ where: label(row), column: words(cols[c]), shown: show(v), recomputed: show(pool[j][c]) });
        });
    });
    let rowCountNote: string | undefined;
    if (!full && shown.length !== expected.rows.length) rowCountNote = `The answer has ${plural(shown.length, 'row')}; a fresh calculation gives ${expected.rows.length.toLocaleString('en-GB')}.`;
    return { checked, matched, differences, rowCountNote, zeroForBlank };
}

// ── Reading the query for the plain checks ──
interface ColumnInfo { name: string; values: Map<string, number>; text: boolean }
function columnIndex(data: Record<string, any>[]): Map<string, ColumnInfo> {
    const out = new Map<string, ColumnInfo>();
    const cols = data.length ? Object.keys(data[0]) : [];
    for (const name of cols) {
        const values = new Map<string, number>();
        let text = false;
        for (const row of data) {
            const v = row[name];
            if (v === null || v === undefined || v === '') continue;
            if (typeof v === 'string' && !/^-?\d+(\.\d+)?$/.test(v.trim())) text = true;
            const k = String(v);
            values.set(k, (values.get(k) || 0) + 1);
            if (values.size > 5000) break;
        }
        out.set(name.toLowerCase(), { name, values, text });
    }
    return out;
}
/** The column a filter side refers to: "x", LOWER("x"), UPPER(TRIM("x")) … */
function filterColumn(e: Expr): { name: string; folded: boolean } | null {
    if (e.k === 'col') return { name: e.name, folded: false };
    if (e.k === 'func' && ['LOWER', 'UPPER', 'TRIM', 'LCASE', 'UCASE'].includes(e.name) && e.args.length === 1) {
        const inner = filterColumn(e.args[0]);
        return inner ? { name: inner.name, folded: inner.folded || e.name !== 'TRIM' } : null;
    }
    if (e.k === 'cast' && /VARCHAR|TEXT|STRING/.test(e.type)) return filterColumn(e.e);
    return null;
}
function literalText(e: Expr): string | null {
    if (e.k === 'lit' && typeof e.v === 'string') return e.v;
    if (e.k === 'func' && ['LOWER', 'UPPER', 'TRIM', 'LCASE', 'UCASE'].includes(e.name) && e.args.length === 1) return literalText(e.args[0]);
    return null;
}
function collectFilterValues(e: Expr | undefined, out: { column: string; value: string; folded: boolean; pattern: boolean }[]): void {
    if (!e) return;
    if (e.k === 'bin' && (e.op === 'AND' || e.op === 'OR')) { collectFilterValues(e.l, out); collectFilterValues(e.r, out); return; }
    if (e.k === 'unary' && e.op === 'NOT') { collectFilterValues(e.e, out); return; }
    if (e.k === 'bin' && (e.op === '=' || e.op === '<>')) {
        const pairs: [Expr, Expr][] = [[e.l, e.r], [e.r, e.l]];
        for (const [c, l] of pairs) {
            const col = filterColumn(c), lit = literalText(l);
            if (col && lit !== null) { out.push({ column: col.name, value: lit, folded: col.folded || (l.k === 'func'), pattern: false }); return; }
        }
        return;
    }
    if (e.k === 'in' && e.list) {
        const col = filterColumn(e.e);
        if (col) for (const item of e.list) { const lit = literalText(item); if (lit !== null) out.push({ column: col.name, value: lit, folded: col.folded, pattern: false }); }
        return;
    }
    if (e.k === 'like') {
        const col = filterColumn(e.e), lit = literalText(e.pat);
        if (col && lit !== null) out.push({ column: col.name, value: lit, folded: e.ci || col.folded, pattern: true });
    }
}
function similarity(a: string, b: string): number {
    const x = a.toLowerCase(), y = b.toLowerCase();
    if (x === y) return 1;
    if (y.includes(x) || x.includes(y)) return 0.8;
    // Edit distance, cheap for short labels.
    const m = x.length, n = y.length;
    if (Math.abs(m - n) > 4) return 0;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    const d = dp[m][n];
    return d <= 2 ? 0.7 - d * 0.1 : 0;
}
function checkFilterValues(q: Query, index: Map<string, ColumnInfo>): FilterValueCheck[] {
    const found: { column: string; value: string; folded: boolean; pattern: boolean }[] = [];
    const visit = (query: Query) => {
        for (const cte of query.ctes) visit(cte.q);
        for (const sel of [query.body, ...query.unions.map(u => u.s)]) {
            collectFilterValues(sel.where, found);
            if (sel.from?.k === 'sub') visit(sel.from.q);
        }
    };
    visit(q);
    const out: FilterValueCheck[] = [];
    const seen = new Set<string>();
    for (const f of found) {
        const info = index.get(f.column.toLowerCase());
        if (!info || !info.text) continue;
        const key = `${info.name}\u0001${f.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let matches = 0;
        const test = f.pattern
            ? new RegExp(`^${[...f.value].map(ch => (ch === '%' ? '[\\s\\S]*' : ch === '_' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`, f.folded ? 'i' : '')
            : null;
        for (const [value, count] of info.values) {
            if (test ? test.test(value) : f.folded ? value.trim().toLowerCase() === f.value.trim().toLowerCase() : value === f.value) matches += count;
        }
        const plain = f.value.replace(/%/g, '').trim();
        const suggestions = matches ? [] : [...info.values.keys()]
            .map(v => ({ v, s: similarity(plain, v) }))
            .filter(x => x.s > 0)
            .sort((x, y) => y.s - x.s)
            .slice(0, 3)
            .map(x => x.v);
        out.push({ column: words(info.name), value: plain, matches, suggestions });
    }
    return out;
}

// ── Saying what was counted ──
function describe(e: Expr, depth = 0): string | null {
    if (depth > 4) return null;
    switch (e.k) {
        case 'col': return words(e.name);
        case 'lit':
            if (e.v === null) return 'blank';
            if (typeof e.v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.v)) return describe({ k: 'date', v: e.v }, depth + 1);
            return typeof e.v === 'string' ? `"${e.v}"` : typeof e.v === 'boolean' ? (e.v ? 'yes' : 'no') : String(e.v);
        case 'date': return new Date(`${e.v.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        case 'cast': return describe(e.e, depth + 1);
        case 'func': {
            if (['LOWER', 'UPPER', 'TRIM', 'ROUND', 'COALESCE'].includes(e.name) && e.args[0]) return describe(e.args[0], depth + 1);
            const inner = e.args[0] && e.args[0].k !== 'star' ? describe(e.args[0], depth + 1) : null;
            if (e.name === 'DATE_TRUNC' && e.args[1]) { const part = e.args[0].k === 'lit' ? String(e.args[0].v) : 'period'; return `${part} of ${describe(e.args[1], depth + 1)}`; }
            if (['YEAR', 'MONTH', 'QUARTER', 'WEEK', 'DAYNAME', 'MONTHNAME'].includes(e.name) && inner) return `${e.name.toLowerCase().replace('name', '')} of ${inner}`;
            return inner;
        }
        case 'bin': {
            const asCondition = (x: Expr) => (x.k === 'col' && (e.op === 'AND' || e.op === 'OR') ? `${words(x.name)} is yes` : describe(x, depth + 1));
            const l = asCondition(e.l), r = asCondition(e.r);
            if (!l || !r) return null;
            const op: Record<string, string> = { '=': 'is', '<>': 'is not', '>': 'is above', '<': 'is below', '>=': 'is at least', '<=': 'is at most', AND: 'and', OR: 'or' };
            if (e.op in op) return `${l} ${op[e.op]} ${r}`;
            return null;
        }
        case 'between': { const x = describe(e.e, depth + 1), lo = describe(e.lo, depth + 1), hi = describe(e.hi, depth + 1); return x && lo && hi ? `${x} is ${e.not ? 'outside' : 'between'} ${lo} and ${hi}` : null; }
        case 'in': { const x = describe(e.e, depth + 1); const items = (e.list || []).map(i => describe(i, depth + 1)); return x && e.list && items.every(Boolean) && items.length <= 4 ? `${x} is ${e.not ? 'not ' : ''}${items.join(' or ')}` : null; }
        case 'like': { const x = describe(e.e, depth + 1); const p = literalText(e.pat); return x && p ? `${x} ${e.not ? 'does not contain' : 'contains'} "${p.replace(/%/g, '')}"` : null; }
        case 'unary': { if (e.op === 'NOT') { if (e.e.k === 'col') return `${words(e.e.name)} is no`; const x = describe(e.e, depth + 1); return x ? `not (${x})` : null; } return null; }
        case 'isnull': { const x = describe(e.e, depth + 1); return x ? `${x} is ${e.not ? 'filled in' : 'blank'}` : null; }
    }
    return null;
}
/** The condition a count counts: COUNT_IF(c), SUM(CASE WHEN c THEN 1 ELSE 0 END), and the reverse. */
function countedCondition(e: Expr): string | null {
    const cond = (c: Expr) => (c.k === 'col' ? `${words(c.name)} is yes` : c.k === 'unary' && c.op === 'NOT' && c.e.k === 'col' ? `${words(c.e.name)} is no` : describe(c));
    if (e.k === 'func' && (e.name === 'COUNT_IF' || e.name === 'COUNTIF') && e.args[0]) return cond(e.args[0]);
    if (e.k === 'func' && e.name === 'SUM' && e.args[0]?.k === 'case' && !e.args[0].operand && e.args[0].whens.length === 1) {
        const w = e.args[0].whens[0], other = e.args[0].else;
        const one = (x?: Expr) => x?.k === 'lit' && x.v === 1, zero = (x?: Expr) => x?.k === 'lit' && x.v === 0;
        if (one(w.then) && zero(other)) return cond(w.when);
        if (zero(w.then) && one(other)) { const c = cond(w.when); return c ? (w.when.k === 'col' ? `${words(w.when.name)} is no` : `not (${c})`) : null; }
    }
    if (e.k === 'func' && e.name === 'COUNT' && e.filter) return cond(e.filter);
    return null;
}
const isRowCount = (e: Expr): boolean => (e.k === 'func' && e.name === 'COUNT' && !e.filter && (!e.args.length || e.args[0].k === 'star'))
    || (e.k === 'func' && e.name === 'NULLIF' && Boolean(e.args[0]) && isRowCount(e.args[0]))
    || (e.k === 'cast' && isRowCount(e.e));
const stripScale = (e: Expr): Expr => {
    if (e.k === 'func' && e.name === 'ROUND' && e.args[0]) return stripScale(e.args[0]);
    if (e.k === 'cast') return stripScale(e.e);
    if (e.k === 'bin' && e.op === '*' && e.l.k === 'lit' && typeof e.l.v === 'number') return stripScale(e.r);
    if (e.k === 'bin' && e.op === '*' && e.r.k === 'lit' && typeof e.r.v === 'number') return stripScale(e.l);
    return e;
};
function measureWords(e: Expr): string | null {
    if (e.k === 'func' && e.name === 'ROUND' && e.args[0]) return measureWords(e.args[0]);
    const core = stripScale(e);
    if (core.k === 'bin' && core.op === '/') {
        const num = stripScale(core.l);
        if (isRowCount(core.r)) {
            const c = countedCondition(num);
            if (c) return `the share of rows where ${c}`;
        }
        const top = measureWords(num), bottom = measureWords(core.r.k === 'func' && core.r.name === 'NULLIF' ? core.r.args[0] : core.r);
        if (top && bottom) return `${top.replace(/^the /, '')} divided by ${bottom.replace(/^the /, '')}`;
        return 'a rate or ratio';
    }
    if (e.k === 'cast') return measureWords(e.e);
    if (e.k === 'func' && !e.over) {
        const arg = e.args[0];
        const what = arg && arg.k !== 'star' ? describe(arg) : null;
        switch (e.name) {
            case 'SUM': return what ? `the total of ${what}` : null;
            case 'AVG': case 'MEAN': return what ? `the average of ${what}` : null;
            case 'MEDIAN': return what ? `the median of ${what}` : null;
            case 'MIN': return what ? `the lowest ${what}` : null;
            case 'MAX': return what ? `the highest ${what}` : null;
            case 'COUNT': {
                if (e.filter) { const c = countedCondition(e); return c ? `the number of rows where ${c}` : null; }
                return !arg || arg.k === 'star' ? 'the number of rows' : e.distinct && what ? `the number of different ${/s$/.test(what) ? what : `${what}s`}` : what ? `the number of rows with ${what}` : null;
            }
            case 'COUNT_IF': case 'COUNTIF': { const c = countedCondition(e); return c ? `the number of rows where ${c}` : null; }
        }
    }
    if (e.k === 'bin' && e.op === '/') return 'a rate or ratio';
    if (e.k === 'bin' && e.op === '*' && (e.l.k === 'bin' || e.r.k === 'bin')) return 'a percentage';
    return null;
}
function countedSentence(q: Query, recordWord?: string): string | undefined {
    const sel = q.body;
    if (q.unions.length || q.ctes.length || sel.from?.k !== 'table') return undefined;
    const measures = sel.items.map(i => measureWords(i.e)).filter((m): m is string => Boolean(m));
    const rows = recordWord ? `${recordWord}s` : 'rows';
    const groups = sel.groupBy === 'ALL'
        ? sel.items.filter(i => !measureWords(i.e)).map(i => (i.alias ? words(i.alias) : describe(i.e)))
        : (sel.groupBy || []).map(g => {
            if (g.k === 'lit' && typeof g.v === 'number') { const item = sel.items[g.v - 1]; return item ? (item.alias ? words(item.alias) : describe(item.e)) : null; }
            return describe(g);
        });
    const where = sel.where ? (sel.where.k === 'col' ? `${words(sel.where.name)} is yes` : describe(sel.where)) : null;
    if (!measures.length && !groups.length) return undefined;
    const parts: string[] = [];
    const rankBy = q.order.length ? measureWords(q.order[0].e) : null;
    const fix = (text: string) => text.replace(/the number of rows/g, `the number of ${rows}`).replace(/share of rows/g, `share of ${rows}`);
    if (measures.length) parts.push(`Worked out ${fix([...new Set(measures)].slice(0, 3).join(', '))}`);
    else if (rankBy && q.limit !== undefined) parts.push(`Ranked by ${fix(rankBy)} (${q.order[0].desc ? 'highest' : 'lowest'} first)`);
    else parts.push('Listed');
    if (groups.length && groups.every(Boolean)) parts.push(`for each ${groups.join(' and ')}`);
    if (sel.where) parts.push(where ? `counting only ${rows} where ${where}` : `with ${rows} filtered by the conditions in the query`);
    if (q.limit !== undefined && q.order.length) parts.push(q.limit === 1 ? 'keeping the first' : `keeping the first ${q.limit}`);
    return `${parts.join(', ')}.`.replace(/\s+/g, ' ');
}

// ── Top N: what share of the whole they cover ──
function topShareNote(q: Query, shown: EvalResult, data: Record<string, any>[], budgetMs: number): string | undefined {
    const sel = q.body;
    if (q.limit === undefined || !q.order.length || !sel.groupBy || q.ctes.length || q.unions.length || sel.from?.k !== 'table' || sel.having || sel.qualify) return undefined;
    const sumIdx = sel.items.findIndex(i => { const inner = i.e.k === 'func' && i.e.name === 'ROUND' ? i.e.args[0] : i.e; return inner.k === 'func' && !inner.over && (inner.name === 'SUM' || (inner.name === 'COUNT' && !inner.distinct)); });
    if (sumIdx < 0) return undefined;
    const totalQuery: Query = { ctes: [], unions: [], order: [], body: { distinct: false, items: [sel.items[sumIdx]], from: sel.from, where: sel.where } };
    try {
        const total = toNum(evaluate(totalQuery, { data }, budgetMs).rows[0]?.[0] ?? null);
        const part = shown.rows.reduce((t, r) => t + (toNum(r[sumIdx]) ?? 0), 0);
        if (!total || total <= 0 || part < 0) return undefined;
        const share = Math.round((part / total) * 1000) / 10;
        const name = words(sel.items[sumIdx].alias || 'the total');
        return `The ${plural(shown.rows.length, 'row')} shown make up ${share}% of all ${name} (${fmt(total)}).`;
    } catch { return undefined; }
}

/** Check one answer. Synchronous and local; keep it off the critical path (call after the answer is drawn). */
export function checkAnswer(input: AnswerCheckInput): AnswerCheck {
    const started = Date.now();
    const budgetMs = input.budgetMs ?? 4000;
    const notes: string[] = [];
    const done = (c: Omit<AnswerCheck, 'ms'>): AnswerCheck => ({ ...c, ms: Date.now() - started });
    let q: Query;
    try { q = parseSQL(input.sql); }
    catch (err) {
        const reason = err instanceof Unsupported ? err.what : 'the query could not be read';
        return done({ status: 'partial', headline: 'Not double-checked: this query uses a form the checker cannot read yet.', figuresChecked: 0, figuresMatched: 0, differences: [], filterValues: [], notes, reason });
    }
    const index = columnIndex(input.data);
    const filterValues = checkFilterValues(q, index);
    const missing = filterValues.filter(f => f.matches === 0);
    const counted = countedSentence(q, input.recordWord);
    const cols = input.rows.length ? Object.keys(input.rows[0]) : [];
    const shown = input.rows.map(r => cols.map(c => normalise(r[c])));

    // Rates stay between 0 and 100.
    cols.forEach((c, i) => {
        if (!RATE_NAME.test(c) || /(change|growth|diff|delta|vs|versus|increase|decrease|uplift|lift)/i.test(c)) return;
        const values = shown.map(r => r[i]).filter((v): v is number => typeof v === 'number');
        if (values.some(v => v < -0.0001 || v > 100.0001)) notes.push(`${words(c)} goes outside 0–100%, which a rate cannot do.`);
    });

    let expected: EvalResult;
    try { expected = evaluate(q, { data: input.data }, budgetMs, input.otherTables); }
    catch (err) {
        const reason = err instanceof Unsupported ? err.what : 'the fresh calculation failed';
        const headline = missing.length
            ? `Check: no rows have ${missing[0].column} = "${missing[0].value}"${missing[0].suggestions.length ? ` — did you mean ${missing[0].suggestions.map(s => `"${s}"`).join(' or ')}?` : '.'}`
            : 'Partly checked: the filters and ranges look right, but this query uses a form the checker cannot recompute yet.';
        return done({ status: missing.length || notes.length ? 'warning' : 'partial', headline, figuresChecked: 0, figuresMatched: 0, differences: [], filterValues, notes, counted, reason });
    }
    if (!input.matchByName && expected.cols.length !== cols.length && shown.length) {
        return done({ status: 'partial', headline: 'Partly checked: the answer has a different set of columns from the query.', figuresChecked: 0, figuresMatched: 0, differences: [], filterValues, notes, counted, reason: 'column count differs' });
    }
    // A LIMIT through tied rows: every shown row must be a real row of the full answer.
    let full: EvalResult | undefined;
    if (expected.limitTie) {
        try { full = evaluate({ ...q, limit: undefined, offset: undefined }, { data: input.data }, budgetMs, input.otherTables); notes.push('Some rows tie for the last place shown, so either could appear; each row shown was checked against the full list.'); }
        catch { full = undefined; }
    }
    // The Builder's rows carry extra keys; read them by the query's column names.
    if (input.matchByName && input.rows.length) {
        const keys = Object.keys(input.rows[0]);
        const pick = expected.cols.map(c => keys.find(k => k === c) ?? keys.find(k => k.toLowerCase() === c.toLowerCase()));
        if (pick.some(k => k === undefined)) {
            return done({ status: 'partial', headline: 'Partly checked: the chart\'s columns could not be matched to the query.', figuresChecked: 0, figuresMatched: 0, differences: [], filterValues, notes, counted, reason: 'columns that could not be matched' });
        }
        shown.splice(0, shown.length, ...input.rows.map(r => pick.map(k => normalise(r[k!]))));
    }
    const compared = compareRows(shown, expected, full);
    if (compared.rowCountNote) notes.push(compared.rowCountNote);
    if (compared.zeroForBlank) notes.push(`${plural(compared.zeroForBlank, 'figure')} ${compared.zeroForBlank === 1 ? 'is' : 'are'} shown as 0 where there is nothing to add up (no values); a fresh calculation leaves ${compared.zeroForBlank === 1 ? 'it' : 'them'} blank.`);
    if (expected.tieSensitive && compared.differences.length) {
        notes.push('Some items tie on the value used to pick them, so which name is shown is a free choice; the figures were compared where they don\'t depend on it.');
    }

    let coverage: string | undefined;
    if (q.body.from?.k === 'table' && !q.ctes.length && expected.rowsTotal) {
        const word = input.recordWord ? `${input.recordWord}s` : 'rows';
        coverage = expected.rowsUsed === expected.rowsTotal
            ? `Based on all ${expected.rowsTotal.toLocaleString('en-GB')} ${word}.`
            : `Based on ${(expected.rowsUsed ?? 0).toLocaleString('en-GB')} of ${expected.rowsTotal.toLocaleString('en-GB')} ${word} (the rest don't meet the question's conditions).`;
    }
    const share = topShareNote(q, expected, input.data, budgetMs);
    if (share) notes.push(share);

    const differences = expected.tieSensitive ? compared.differences.filter(d => d.column && /\d/.test(d.shown) && /\d/.test(d.recomputed) && !Number.isNaN(Number(d.shown.replace(/,/g, '')))) : compared.differences;
    const nFig = compared.checked;
    if (differences.length || (compared.rowCountNote && !full)) {
        const n = differences.length || 1;
        return done({
            status: 'mismatch',
            headline: differences.length
                ? `${plural(n, 'figure')} ${n === 1 ? "doesn't" : "don't"} match a fresh calculation from your cleaned data.`
                : "The answer has a different number of rows from a fresh calculation.",
            figuresChecked: nFig, figuresMatched: compared.matched, differences: differences.slice(0, 50), filterValues, coverage, counted, notes,
        });
    }
    if (missing.length) {
        const f = missing[0];
        return done({
            status: 'warning',
            headline: `Figures match, but no rows have ${f.column} = "${f.value}"${f.suggestions.length ? ` — did you mean ${f.suggestions.map(s => `"${s}"`).join(' or ')}?` : '.'}`,
            figuresChecked: nFig, figuresMatched: compared.matched, differences: [], filterValues, coverage, counted, notes,
        });
    }
    if (notes.some(n => /cannot do/.test(n))) {
        return done({ status: 'warning', headline: notes.find(n => /cannot do/.test(n))!, figuresChecked: nFig, figuresMatched: compared.matched, differences: [], filterValues, coverage, counted, notes });
    }
    return done({
        status: 'verified',
        headline: nFig
            ? `${nFig === 1 ? 'The figure matches' : `All ${nFig.toLocaleString('en-GB')} figures match`} a fresh calculation from your cleaned data.`
            : 'The answer matches a fresh calculation from your cleaned data.',
        figuresChecked: nFig, figuresMatched: compared.matched, differences: [], filterValues, coverage, counted, notes,
    });
}
