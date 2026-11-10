/**
 * Works a parsed query out over the cleaned rows, in plain TypeScript — a
 * second calculation that shares nothing with DuckDB. Values follow DuckDB's
 * rules where they matter for the figures: three-valued NULL logic, NULLs left
 * out of aggregates, ROUND half away from zero, "/" always a decimal division,
 * text compared byte by byte, NULLs sorted last.
 *
 * Where DuckDB itself could give more than one right answer (ties under a
 * LIMIT, ROW_NUMBER over equal values, ARG_MAX between equal maxima) the
 * result says so, so the check never calls a legitimate answer wrong.
 */
import { Unsupported, type Expr, type Query, type Select, type OrderItem, type TableRef } from './sqlParser';
import { duckColumnType, duckCellValue } from '../../utils/duckColumnType';

/** A date or timestamp, held as UTC milliseconds. */
export class SqlDate {
    constructor(public ms: number, public ts: boolean) {}
    toString(): string {
        const iso = new Date(this.ms).toISOString();
        return !this.ts || iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
    }
}
export type Value = number | string | boolean | null | SqlDate;

export interface Relation { cols: string[]; rows: Value[][]; index: Map<string, number> }

export interface EvalResult {
    cols: string[];
    rows: Value[][];
    /** A LIMIT cut through rows that sort equal: other equally right rows exist. */
    limitTie: boolean;
    /** ROW_NUMBER / ARG_MAX / MODE met equal values: which item is shown is DuckDB's choice. */
    tieSensitive: boolean;
    /** Rows of the table after WHERE (outer query), for coverage. */
    rowsUsed?: number;
    rowsTotal?: number;
    /** For each result row: how many rows of the data stand behind it. */
    rowsBehind: number[];
    /** For each figure: how many rows of the data it was worked out from (0 = not a statistic). */
    cellBase: number[][];
}

const DAY = 86_400_000;
const AGGREGATES = new Set(['SUM', 'AVG', 'MEAN', 'COUNT', 'COUNT_IF', 'COUNTIF', 'MIN', 'MAX', 'MEDIAN', 'QUANTILE_CONT', 'PERCENTILE_CONT',
    'STDDEV', 'STDDEV_SAMP', 'STDDEV_POP', 'VARIANCE', 'VAR_SAMP', 'VAR_POP', 'ARG_MAX', 'ARGMAX', 'MAX_BY', 'ARG_MIN', 'ARGMIN', 'MIN_BY',
    'BOOL_OR', 'BOOL_AND', 'ANY_VALUE', 'FIRST', 'LAST', 'MODE', 'PRODUCT', 'FSUM', 'SUMKAHAN', 'KAHAN_SUM', 'AVG_DISTINCT', 'ENTROPY', 'LIST', 'STRING_AGG', 'GROUP_CONCAT', 'ARRAY_AGG', 'HISTOGRAM', 'APPROX_COUNT_DISTINCT', 'APPROX_QUANTILE', 'CORR', 'COVAR_POP', 'COVAR_SAMP', 'REGR_SLOPE']);
const WINDOW_ONLY = new Set(['ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK', 'CUME_DIST', 'NTILE', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE', 'NTH_VALUE']);

// ── Loading the table the way the app loads it into DuckDB ──
const loaded = new WeakMap<object, Relation>();
export function relationFromRows(rows: Record<string, any>[]): Relation {
    const hit = loaded.get(rows);
    if (hit) return hit;
    const cols = rows.length ? Object.keys(rows[0]) : [];
    const types = cols.map(col => duckColumnType(rows, col));
    const out: Value[][] = new Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
        const src = rows[i];
        const row: Value[] = new Array(cols.length);
        for (let c = 0; c < cols.length; c++) {
            row[c] = duckCellValue(src[cols[c]], types[c]);
        }
        out[i] = row;
    }
    const rel = makeRelation(cols, out);
    loaded.set(rows, rel);
    return rel;
}
function makeRelation(cols: string[], rows: Value[][]): Relation {
    const index = new Map<string, number>();
    cols.forEach((c, i) => { if (!index.has(c.toLowerCase())) index.set(c.toLowerCase(), i); });
    return { cols, rows, index };
}

// ── Value helpers ──
const isNum = (v: Value): v is number => typeof v === 'number';
export function toNum(v: Value): number | null {
    if (v === null) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') { const t = v.trim(); if (t === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return null; return Number(t); }
    return null;
}
export function toDate(v: Value, ts = false): SqlDate | null {
    if (v === null) return null;
    if (v instanceof SqlDate) return ts || !v.ts ? new SqlDate(v.ms, ts || v.ts) : new SqlDate(Math.floor(v.ms / DAY) * DAY, false);
    if (typeof v !== 'string') return null;
    const m = v.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/);
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], ts ? +(m[4] || 0) : 0, ts ? +(m[5] || 0) : 0, ts ? +(m[6] || 0) : 0);
    const check = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (check.getUTCMonth() !== +m[2] - 1) return null;
    return new SqlDate(ms, ts);
}
function truthy(v: Value): boolean | null {
    if (v === null) return null;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') { const t = v.trim().toLowerCase(); if (t === 'true' || t === 't' || t === '1') return true; if (t === 'false' || t === 'f' || t === '0') return false; return null; }
    return null;
}
/** DuckDB-style ordering of two non-null values; dates against text read the text as a date. */
export function compareValues(a: Value, b: Value): number {
    if (a instanceof SqlDate || b instanceof SqlDate) {
        const da = toDate(a, true), db = toDate(b, true);
        if (da && db) return da.ms - db.ms;
        return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    }
    if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
    if (isNum(a) || isNum(b)) {
        const na = toNum(a as Value), nb = toNum(b as Value);
        if (na !== null && nb !== null) return na - nb;
    }
    const sa = String(a), sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}
/** A key that groups equal values together (1 and 1.0 alike; dates by instant). */
export function keyOf(v: Value): string {
    if (v === null) return '\u0000';
    if (v instanceof SqlDate) return `d${v.ms}`;
    if (typeof v === 'number') return `n${Object.is(v, -0) ? 0 : v}`;
    if (typeof v === 'boolean') return `b${v}`;
    return `s${v}`;
}
function roundHalfAway(x: number, digits: number): number {
    const p = Math.pow(10, digits);
    const r = Math.sign(x) * Math.round(Math.abs(x) * p) / p;
    return Object.is(r, -0) ? 0 : r;
}
function addMonths(d: SqlDate, months: number): SqlDate {
    const t = new Date(d.ms);
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + months;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const day = Math.min(t.getUTCDate(), last);
    return new SqlDate(Date.UTC(y, m, day, t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds()), d.ts);
}
function addInterval(d: SqlDate, n: number, unit: string): SqlDate {
    switch (unit) {
        case 'year': return addMonths(d, 12 * n);
        case 'quarter': return addMonths(d, 3 * n);
        case 'month': return addMonths(d, n);
        case 'week': return new SqlDate(d.ms + 7 * n * DAY, d.ts);
        case 'day': return new SqlDate(d.ms + n * DAY, d.ts);
        case 'hour': return new SqlDate(d.ms + n * 3_600_000, true);
        case 'minute': return new SqlDate(d.ms + n * 60_000, true);
        case 'second': return new SqlDate(d.ms + n * 1000, true);
    }
    throw new Unsupported(`interval ${unit}`);
}
function datePart(part: string, d: SqlDate): number {
    const t = new Date(d.ms);
    switch (part.toLowerCase().replace(/s$/, '')) {
        case 'year': case 'yyyy': case 'yy': return t.getUTCFullYear();
        case 'quarter': return Math.floor(t.getUTCMonth() / 3) + 1;
        case 'month': case 'mon': return t.getUTCMonth() + 1;
        case 'day': case 'dd': case 'dayofmonth': return t.getUTCDate();
        case 'dow': case 'dayofweek': case 'weekday': return t.getUTCDay();
        case 'isodow': return t.getUTCDay() || 7;
        case 'doy': case 'dayofyear': return Math.round((d.ms - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY) + 1;
        case 'week': case 'weekofyear': case 'isoweek': case 'w': return isoWeek(t).week;
        case 'isoyear': return isoWeek(t).year;
        case 'hour': return t.getUTCHours();
        case 'minute': return t.getUTCMinutes();
        case 'second': return t.getUTCSeconds();
        case 'epoch': return d.ms / 1000;
    }
    throw new Unsupported(`date part ${part}`);
}
function isoWeek(t: Date): { year: number; week: number } {
    const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
    return { year: d.getUTCFullYear(), week: Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7) };
}
function dateTrunc(part: string, d: SqlDate): SqlDate {
    const t = new Date(d.ms);
    const y = t.getUTCFullYear(), m = t.getUTCMonth(), day = t.getUTCDate();
    switch (part.toLowerCase().replace(/s$/, '')) {
        case 'year': return new SqlDate(Date.UTC(y, 0, 1), false);
        case 'quarter': return new SqlDate(Date.UTC(y, Math.floor(m / 3) * 3, 1), false);
        case 'month': return new SqlDate(Date.UTC(y, m, 1), false);
        case 'week': { const dow = t.getUTCDay() || 7; return new SqlDate(Date.UTC(y, m, day - dow + 1), false); }
        case 'day': return new SqlDate(Date.UTC(y, m, day), false);
        case 'hour': return new SqlDate(Date.UTC(y, m, day, t.getUTCHours()), true);
        case 'minute': return new SqlDate(Date.UTC(y, m, day, t.getUTCHours(), t.getUTCMinutes()), true);
    }
    throw new Unsupported(`date_trunc ${part}`);
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function strftime(d: SqlDate, fmt: string): string {
    const t = new Date(d.ms);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return fmt.replace(/%(-?)([a-zA-Z%])/g, (_m, dash: string, c: string) => {
        const p2 = (n: number) => (dash ? String(n) : pad(n));
        switch (c) {
            case 'Y': return String(t.getUTCFullYear());
            case 'y': return pad(t.getUTCFullYear() % 100);
            case 'm': return p2(t.getUTCMonth() + 1);
            case 'd': return p2(t.getUTCDate());
            case 'e': return String(t.getUTCDate()).padStart(2, ' ');
            case 'B': return MONTHS[t.getUTCMonth()];
            case 'b': case 'h': return MONTHS[t.getUTCMonth()].slice(0, 3);
            case 'A': return DAYS[t.getUTCDay()];
            case 'a': return DAYS[t.getUTCDay()].slice(0, 3);
            case 'H': return p2(t.getUTCHours());
            case 'I': return p2(t.getUTCHours() % 12 || 12);
            case 'p': return t.getUTCHours() < 12 ? 'AM' : 'PM';
            case 'M': return p2(t.getUTCMinutes());
            case 'S': return p2(t.getUTCSeconds());
            case 'j': return dash ? String(datePart('doy', d)) : pad(datePart('doy', d), 3);
            case 'w': return String(t.getUTCDay());
            case 'u': return String(t.getUTCDay() || 7);
            case 'V': return pad(isoWeek(t).week);
            case 'G': return String(isoWeek(t).year);
            case 'F': return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
            case '%': return '%';
        }
        throw new Unsupported(`strftime %${c}`);
    });
}
function likeToRegex(pattern: string, ci: boolean): RegExp {
    let re = '';
    for (const ch of pattern) re += ch === '%' ? '[\\s\\S]*' : ch === '_' ? '[\\s\\S]' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${re}$`, ci ? 'i' : '');
}
function castTo(v: Value, type: string, tryCast: boolean): Value {
    if (v === null) return null;
    const t = type.toUpperCase();
    const fail = (): Value => { if (tryCast) return null; throw new Unsupported(`cast of ${String(v)} to ${t}`); };
    if (['DATE'].includes(t)) return toDate(v instanceof SqlDate ? v : String(v)) ?? fail();
    if (['TIMESTAMP', 'DATETIME', 'TIMESTAMP_S', 'TIMESTAMP_MS'].includes(t)) return toDate(v instanceof SqlDate ? v : String(v), true) ?? fail();
    if (['VARCHAR', 'TEXT', 'STRING', 'CHAR', 'BPCHAR'].includes(t)) {
        if (v instanceof SqlDate) return v.toString();
        if (typeof v === 'boolean') return v ? 'true' : 'false';
        return String(v);
    }
    if (['DOUBLE', 'FLOAT', 'REAL', 'DECIMAL', 'NUMERIC', 'FLOAT4', 'FLOAT8'].includes(t)) { const n = toNum(v); return n ?? fail(); }
    if (['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'HUGEINT', 'INT4', 'INT8', 'LONG', 'UBIGINT', 'UINTEGER'].includes(t)) {
        const n = toNum(v); return n === null ? fail() : roundHalfAway(n, 0);
    }
    if (t === 'BOOLEAN' || t === 'BOOL') { const b = truthy(v); return b ?? fail(); }
    throw new Unsupported(`cast to ${t}`);
}

// ── Evaluation ──
interface Scope {
    rel: Relation;
    row: Value[];
    group?: Value[][];
    win?: Map<Expr, Value>;
    /** For window aggregates: how many data rows the window covered. */
    winBase?: Map<Expr, number>;
    aliases?: Map<string, Expr>;
    outValues?: Map<string, Value>;
    /** Names being resolved through aliases (guards against loops). */
    resolving?: Set<string>;
}
export interface Env {
    tables: Map<string, Relation>;
    deadline: number;
    tick: number;
    tieSensitive: boolean;
    subCache: Map<Query, EvalResult>;
    /** Other uploaded tables (and dim_date): not worked out by the check. */
    otherTables: Set<string>;
}

export function containsAggregate(e: Expr | undefined): boolean {
    if (!e) return false;
    switch (e.k) {
        case 'func':
            if (!e.over && AGGREGATES.has(e.name)) return true;
            return e.args.some(containsAggregate) || containsAggregate(e.filter);
        case 'unary': case 'isnull': case 'cast': return containsAggregate(e.e);
        case 'bin': return containsAggregate(e.l) || containsAggregate(e.r);
        case 'in': return containsAggregate(e.e) || (e.list || []).some(containsAggregate);
        case 'between': return containsAggregate(e.e) || containsAggregate(e.lo) || containsAggregate(e.hi);
        case 'like': return containsAggregate(e.e) || containsAggregate(e.pat);
        case 'case': return containsAggregate(e.operand) || e.whens.some(w => containsAggregate(w.when) || containsAggregate(w.then)) || containsAggregate(e.else);
        default: return false;
    }
}
function collectWindows(e: Expr | undefined, out: Expr[]): void {
    if (!e) return;
    switch (e.k) {
        case 'func': if (e.over) out.push(e); else { e.args.forEach(a => collectWindows(a, out)); collectWindows(e.filter, out); } return;
        case 'unary': case 'isnull': case 'cast': collectWindows(e.e, out); return;
        case 'bin': collectWindows(e.l, out); collectWindows(e.r, out); return;
        case 'in': collectWindows(e.e, out); (e.list || []).forEach(a => collectWindows(a, out)); return;
        case 'between': collectWindows(e.e, out); collectWindows(e.lo, out); collectWindows(e.hi, out); return;
        case 'like': collectWindows(e.e, out); collectWindows(e.pat, out); return;
        case 'case': collectWindows(e.operand, out); e.whens.forEach(w => { collectWindows(w.when, out); collectWindows(w.then, out); }); collectWindows(e.else, out); return;
    }
}

function tick(env: Env): void {
    if ((++env.tick & 0xffff) === 0 && Date.now() > env.deadline) throw new Unsupported('the check took too long');
}

function evalExpr(e: Expr, s: Scope, env: Env): Value {
    switch (e.k) {
        case 'lit': return e.v;
        case 'date': return toDate(e.v, Boolean(e.ts)) ?? (() => { throw new Unsupported(`date '${e.v}'`); })();
        case 'interval': throw new Unsupported('interval on its own');
        case 'star': throw new Unsupported('* in an expression');
        case 'col': {
            const i = s.rel.index.get(e.name.toLowerCase());
            if (i !== undefined) return s.row[i];
            const key = e.name.toLowerCase();
            if (s.outValues?.has(key)) return s.outValues.get(key)!;
            const aliasExpr = s.aliases?.get(key);
            if (aliasExpr && !s.resolving?.has(key)) {
                const resolving = new Set(s.resolving || []); resolving.add(key);
                return evalExpr(aliasExpr, { ...s, resolving }, env);
            }
            throw new Unsupported(`column ${e.name}`);
        }
        case 'unary': {
            const v = evalExpr(e.e, s, env);
            if (e.op === 'NOT') { const b = truthy(v); return b === null ? null : !b; }
            if (v === null) return null;
            const n = toNum(v); if (n === null) throw new Unsupported('minus on text');
            return -n;
        }
        case 'bin': return evalBinary(e, s, env);
        case 'isnull': { const v = evalExpr(e.e, s, env); return e.not ? v !== null : v === null; }
        case 'between': {
            const v = evalExpr(e.e, s, env), lo = evalExpr(e.lo, s, env), hi = evalExpr(e.hi, s, env);
            if (v === null || lo === null || hi === null) return null;
            const inside = compareValues(v, lo) >= 0 && compareValues(v, hi) <= 0;
            return e.not ? !inside : inside;
        }
        case 'in': {
            const v = evalExpr(e.e, s, env);
            if (v === null) return null;
            let values: Value[];
            if (e.sub) values = runQuery(e.sub, env).rows.map(r => r[0]);
            else values = (e.list || []).map(item => evalExpr(item, s, env));
            let sawNull = false;
            for (const item of values) { if (item === null) { sawNull = true; continue; } if (compareValues(v, item) === 0) return !e.not; }
            return sawNull ? null : e.not;
        }
        case 'like': {
            const v = evalExpr(e.e, s, env), pat = evalExpr(e.pat, s, env);
            if (v === null || pat === null) return null;
            const hit = likeToRegex(String(pat), e.ci).test(v instanceof SqlDate ? v.toString() : String(v));
            return e.not ? !hit : hit;
        }
        case 'case': {
            if (e.operand) {
                const v = evalExpr(e.operand, s, env);
                for (const w of e.whens) { const c = evalExpr(w.when, s, env); if (v !== null && c !== null && compareValues(v, c) === 0) return evalExpr(w.then, s, env); }
            } else {
                for (const w of e.whens) if (truthy(evalExpr(w.when, s, env)) === true) return evalExpr(w.then, s, env);
            }
            return e.else ? evalExpr(e.else, s, env) : null;
        }
        case 'cast': return castTo(evalExpr(e.e, s, env), e.type, e.tryCast);
        case 'sub': {
            const r = runQuery(e.q, env);
            return r.rows.length ? r.rows[0][0] : null;
        }
        case 'func': {
            if (e.over) {
                if (!s.win?.has(e)) throw new Unsupported('window function here');
                return s.win.get(e)!;
            }
            if (AGGREGATES.has(e.name)) return evalAggregate(e, s, env);
            if (WINDOW_ONLY.has(e.name)) throw new Unsupported(`${e.name} without OVER`);
            return evalFunction(e, s, env);
        }
    }
}

function evalBinary(e: Extract<Expr, { k: 'bin' }>, s: Scope, env: Env): Value {
    if (e.op === 'AND') {
        const l = truthy(evalExpr(e.l, s, env));
        if (l === false) return false;
        const r = truthy(evalExpr(e.r, s, env));
        if (r === false) return false;
        return l === null || r === null ? null : true;
    }
    if (e.op === 'OR') {
        const l = truthy(evalExpr(e.l, s, env));
        if (l === true) return true;
        const r = truthy(evalExpr(e.r, s, env));
        if (r === true) return true;
        return l === null || r === null ? null : false;
    }
    if (e.op === 'ISTRUE' || e.op === 'ISNOTTRUE' || e.op === 'ISFALSE' || e.op === 'ISNOTFALSE') {
        const b = truthy(evalExpr(e.l, s, env));
        if (e.op === 'ISTRUE') return b === true;
        if (e.op === 'ISNOTTRUE') return b !== true;
        if (e.op === 'ISFALSE') return b === false;
        return b !== false;
    }
    // Date ± interval
    if ((e.op === '+' || e.op === '-') && (e.r.k === 'interval' || e.l.k === 'interval')) {
        const iv = (e.r.k === 'interval' ? e.r : e.l) as Extract<Expr, { k: 'interval' }>;
        const other = evalExpr(e.r.k === 'interval' ? e.l : e.r, s, env);
        if (other === null) return null;
        const d = toDate(other, other instanceof SqlDate ? other.ts : /\d:\d/.test(String(other)));
        if (!d) throw new Unsupported('interval on a non-date');
        return addInterval(d, e.op === '-' ? -iv.n : iv.n, iv.unit);
    }
    const l = evalExpr(e.l, s, env), r = evalExpr(e.r, s, env);
    if (e.op === 'DISTINCT' || e.op === 'NOTDISTINCT') {
        const same = (l === null && r === null) || (l !== null && r !== null && compareValues(l, r) === 0);
        return e.op === 'DISTINCT' ? !same : same;
    }
    if (l === null || r === null) return null;
    switch (e.op) {
        case '=': return compareValues(l, r) === 0;
        case '<>': return compareValues(l, r) !== 0;
        case '<': return compareValues(l, r) < 0;
        case '>': return compareValues(l, r) > 0;
        case '<=': return compareValues(l, r) <= 0;
        case '>=': return compareValues(l, r) >= 0;
        case '||': return `${l instanceof SqlDate ? l.toString() : l}${r instanceof SqlDate ? r.toString() : r}`;
    }
    // Date arithmetic: date - date = days; date ± whole days.
    if (l instanceof SqlDate || r instanceof SqlDate) {
        if (e.op === '-' && l instanceof SqlDate && r instanceof SqlDate) return Math.round((l.ms - r.ms) / DAY);
        const d = (l instanceof SqlDate ? l : r) as SqlDate, n = toNum(l instanceof SqlDate ? r : l);
        if (n !== null && (e.op === '+' || (e.op === '-' && l instanceof SqlDate))) return new SqlDate(d.ms + (e.op === '-' ? -n : n) * DAY, d.ts);
        throw new Unsupported('date arithmetic');
    }
    const a = toNum(l), b = toNum(r);
    if (a === null || b === null) throw new Unsupported(`arithmetic on text (${e.op})`);
    switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? null : a / b;
        case '//': return b === 0 ? null : Math.floor(a / b);
        case '%': return b === 0 ? null : a % b;
    }
    throw new Unsupported(`operator ${e.op}`);
}

function evalFunction(e: Extract<Expr, { k: 'func' }>, s: Scope, env: Env): Value {
    const name = e.name;
    if (name === '__MEMBER') return evalExpr(e.args[0], memberScopes[s.row[0] as number], env);
    const args = () => e.args.map(a => evalExpr(a, s, env));
    // Lazy ones first.
    if (name === 'COALESCE' || name === 'IFNULL' || name === 'NVL') { for (const a of e.args) { const v = evalExpr(a, s, env); if (v !== null) return v; } return null; }
    if (name === 'IF' || name === 'IFF') return truthy(evalExpr(e.args[0], s, env)) === true ? evalExpr(e.args[1], s, env) : evalExpr(e.args[2], s, env);
    const a = args();
    const num = (i: number) => toNum(a[i]);
    const str = (i: number) => (a[i] === null ? null : a[i] instanceof SqlDate ? (a[i] as SqlDate).toString() : String(a[i]));
    const anyNull = (n = a.length) => a.slice(0, n).some(v => v === null);
    switch (name) {
        case 'NULLIF': return a[0] !== null && a[1] !== null && compareValues(a[0], a[1]) === 0 ? null : a[0];
        case 'ROUND': { if (anyNull(1)) return null; const x = num(0); if (x === null) throw new Unsupported('ROUND of text'); return roundHalfAway(x, a.length > 1 ? (num(1) ?? 0) : 0); }
        case 'ROUND_EVEN': throw new Unsupported('ROUND_EVEN');
        case 'FLOOR': return anyNull() ? null : Math.floor(num(0)!);
        case 'CEIL': case 'CEILING': return anyNull() ? null : Math.ceil(num(0)!);
        case 'TRUNC': return anyNull() ? null : Math.trunc(num(0)!);
        case 'ABS': return anyNull() ? null : Math.abs(num(0)!);
        case 'SIGN': return anyNull() ? null : Math.sign(num(0)!);
        case 'SQRT': { if (anyNull()) return null; const x = num(0)!; return x < 0 ? null : Math.sqrt(x); }
        case 'POWER': case 'POW': return anyNull() ? null : Math.pow(num(0)!, num(1)!);
        case 'EXP': return anyNull() ? null : Math.exp(num(0)!);
        case 'LN': return anyNull() ? null : Math.log(num(0)!);
        case 'LOG': case 'LOG10': return anyNull() ? null : (a.length === 2 && name === 'LOG' ? Math.log(num(1)!) / Math.log(num(0)!) : Math.log10(num(0)!));
        case 'LOG2': return anyNull() ? null : Math.log2(num(0)!);
        case 'MOD': return anyNull() ? null : (num(1) === 0 ? null : num(0)! % num(1)!);
        case 'GREATEST': case 'LEAST': {
            const vals = a.filter(v => v !== null);
            if (!vals.length) return null;
            return vals.reduce((best, v) => (name === 'GREATEST' ? compareValues(v, best) > 0 : compareValues(v, best) < 0) ? v : best);
        }
        case 'LOWER': case 'LCASE': return a[0] === null ? null : str(0)!.toLowerCase();
        case 'UPPER': case 'UCASE': return a[0] === null ? null : str(0)!.toUpperCase();
        case 'TRIM': return a[0] === null ? null : str(0)!.trim();
        case 'LTRIM': return a[0] === null ? null : str(0)!.replace(/^\s+/, '');
        case 'RTRIM': return a[0] === null ? null : str(0)!.replace(/\s+$/, '');
        case 'LENGTH': case 'LEN': case 'CHAR_LENGTH': case 'CHARACTER_LENGTH': case 'STRLEN': return a[0] === null ? null : [...str(0)!].length;
        case 'SUBSTR': case 'SUBSTRING': {
            if (anyNull()) return null;
            const chars = [...str(0)!];
            let start = num(1)!;
            if (start < 0) start = chars.length + start + 1;
            const from = Math.max(start - 1, 0);
            const len = a.length > 2 ? num(2)! : chars.length;
            const end = start - 1 + len;
            return chars.slice(from, Math.max(from, end)).join('');
        }
        case 'LEFT': return anyNull() ? null : [...str(0)!].slice(0, Math.max(0, num(1)!)).join('');
        case 'RIGHT': { if (anyNull()) return null; const chars = [...str(0)!]; const n = num(1)!; return n <= 0 ? '' : chars.slice(-n).join(''); }
        case 'CONCAT': return a.filter(v => v !== null).map(v => (v instanceof SqlDate ? v.toString() : String(v))).join('');
        case 'CONCAT_WS': { if (a[0] === null) return null; return a.slice(1).filter(v => v !== null).map(v => (v instanceof SqlDate ? v.toString() : String(v))).join(str(0)!); }
        case 'REPLACE': return anyNull() ? null : str(0)!.split(str(1)!).join(str(2)!);
        case 'LPAD': case 'RPAD': {
            if (anyNull()) return null;
            const text = str(0)!, width = num(1)!, pad = a.length > 2 ? str(2)! : ' ';
            if (text.length >= width) return text.slice(0, width);
            const fill = pad.repeat(Math.ceil((width - text.length) / Math.max(pad.length, 1))).slice(0, width - text.length);
            return name === 'LPAD' ? fill + text : text + fill;
        }
        case 'CONTAINS': return anyNull() ? null : str(0)!.includes(str(1)!);
        case 'STARTS_WITH': case 'PREFIX': return anyNull() ? null : str(0)!.startsWith(str(1)!);
        case 'ENDS_WITH': case 'SUFFIX': return anyNull() ? null : str(0)!.endsWith(str(1)!);
        case 'SPLIT_PART': { if (anyNull()) return null; const parts = str(0)!.split(str(1)!); const i = num(2)!; return parts[i > 0 ? i - 1 : parts.length + i] ?? ''; }
        case 'DATE_TRUNC': case 'DATETRUNC': { if (anyNull()) return null; const d = toDate(a[1], true); if (!d) throw new Unsupported('date_trunc of a non-date'); return dateTrunc(str(0)!, d); }
        case 'DATE_PART': case 'DATEPART': { if (anyNull()) return null; const d = toDate(a[1], true); if (!d) throw new Unsupported('date_part of a non-date'); return datePart(str(0)!, d); }
        case 'YEAR': case 'MONTH': case 'DAY': case 'QUARTER': case 'WEEK': case 'WEEKOFYEAR': case 'DAYOFWEEK': case 'DOW': case 'ISODOW': case 'DAYOFYEAR': case 'DAYOFMONTH': case 'HOUR': case 'MINUTE': case 'ISOYEAR': {
            if (a[0] === null) return null;
            const d = toDate(a[0], true); if (!d) throw new Unsupported(`${name} of a non-date`);
            return datePart(name === 'DOW' ? 'dow' : name, d);
        }
        case 'DAYNAME': { if (a[0] === null) return null; const d = toDate(a[0], true); if (!d) throw new Unsupported('dayname'); return DAYS[new Date(d.ms).getUTCDay()]; }
        case 'MONTHNAME': { if (a[0] === null) return null; const d = toDate(a[0], true); if (!d) throw new Unsupported('monthname'); return MONTHS[new Date(d.ms).getUTCMonth()]; }
        case 'STRFTIME': {
            if (anyNull()) return null;
            // DuckDB order is (date, format); SQLite's (format, date) is accepted too.
            const [dv, fv] = typeof a[0] === 'string' && /%/.test(a[0]) && toDate(a[0]) === null ? [a[1], a[0]] : [a[0], a[1]];
            const d = toDate(dv, true); if (!d) throw new Unsupported('strftime of a non-date');
            return strftime(d, String(fv));
        }
        case 'LAST_DAY': { if (a[0] === null) return null; const d = toDate(a[0]); if (!d) throw new Unsupported('last_day'); const t = new Date(d.ms); return new SqlDate(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0), false); }
        case 'MAKE_DATE': return anyNull() ? null : new SqlDate(Date.UTC(num(0)!, num(1)! - 1, num(2)!), false);
        case 'DATE_DIFF': case 'DATEDIFF': {
            if (anyNull()) return null;
            const part = str(0)!.toLowerCase().replace(/s$/, '');
            const x = toDate(a[1], true), y = toDate(a[2], true);
            if (!x || !y) throw new Unsupported('date_diff of a non-date');
            const tx = new Date(x.ms), ty = new Date(y.ms);
            if (part === 'day') return Math.round((Date.UTC(ty.getUTCFullYear(), ty.getUTCMonth(), ty.getUTCDate()) - Date.UTC(tx.getUTCFullYear(), tx.getUTCMonth(), tx.getUTCDate())) / DAY);
            if (part === 'month') return (ty.getUTCFullYear() - tx.getUTCFullYear()) * 12 + ty.getUTCMonth() - tx.getUTCMonth();
            if (part === 'quarter') return (ty.getUTCFullYear() - tx.getUTCFullYear()) * 4 + Math.floor(ty.getUTCMonth() / 3) - Math.floor(tx.getUTCMonth() / 3);
            if (part === 'year') return ty.getUTCFullYear() - tx.getUTCFullYear();
            throw new Unsupported(`date_diff ${part}`);
        }
        case 'DATE_ADD': {
            if (anyNull()) return null;
            const iv = e.args[1];
            const d = toDate(a[0], a[0] instanceof SqlDate && a[0].ts);
            if (!d || iv.k !== 'interval') throw new Unsupported('date_add');
            return addInterval(d, iv.n, iv.unit);
        }
        case 'TO_DATE': throw new Unsupported('to_date');
        case 'STRPTIME': throw new Unsupported('strptime');
    }
    throw new Unsupported(`function ${name}`);
}

function evalAggregate(e: Extract<Expr, { k: 'func' }>, s: Scope, env: Env): Value {
    if (!s.group) throw new Unsupported(`${e.name} outside a group`);
    const name = e.name;
    let rows = s.group;
    const scopeFor = (row: Value[]): Scope => ({ rel: s.rel, row, aliases: s.aliases });
    if (e.filter) rows = rows.filter(row => truthy(evalExpr(e.filter!, scopeFor(row), env)) === true);
    if (name === 'COUNT' && (e.args.length === 0 || e.args[0].k === 'star')) return rows.length;
    if (name === 'COUNT_IF' || name === 'COUNTIF') { let n = 0; for (const row of rows) { tick(env); if (truthy(evalExpr(e.args[0], scopeFor(row), env)) === true) n++; } return n; }
    if (e.args.length > 1 && !['ARG_MAX', 'ARGMAX', 'MAX_BY', 'ARG_MIN', 'ARGMIN', 'MIN_BY', 'QUANTILE_CONT', 'PERCENTILE_CONT'].includes(name)) throw new Unsupported(`${name} with several arguments`);
    const values: Value[] = [];
    const seconds: Value[] = [];
    for (const row of rows) {
        tick(env);
        const sc = scopeFor(row);
        const v = evalExpr(e.args[0], sc, env);
        if (['ARG_MAX', 'ARGMAX', 'MAX_BY', 'ARG_MIN', 'ARGMIN', 'MIN_BY'].includes(name)) {
            const by = evalExpr(e.args[1], sc, env);
            if (by === null) continue;
            values.push(v); seconds.push(by);
            continue;
        }
        if (v !== null) values.push(v);
    }
    let vals = values;
    if (e.distinct) { const seen = new Set<string>(); vals = values.filter(v => { const k = keyOf(v); if (seen.has(k)) return false; seen.add(k); return true; }); }
    const nums = () => vals.map(v => { const n = toNum(v); if (n === null) throw new Unsupported(`${name} of text`); return n; });
    switch (name) {
        case 'COUNT': return vals.length;
        case 'SUM': case 'FSUM': case 'SUMKAHAN': case 'KAHAN_SUM': { if (!vals.length) return null; return nums().reduce((t, n) => t + n, 0); }
        case 'PRODUCT': { if (!vals.length) return null; return nums().reduce((t, n) => t * n, 1); }
        case 'AVG': case 'MEAN': { if (!vals.length) return null; const n = nums(); return n.reduce((t, x) => t + x, 0) / n.length; }
        case 'MIN': case 'MAX': {
            if (!vals.length) return null;
            return vals.reduce((best, v) => (name === 'MAX' ? compareValues(v, best) > 0 : compareValues(v, best) < 0) ? v : best);
        }
        case 'MEDIAN': case 'QUANTILE_CONT': case 'PERCENTILE_CONT': {
            if (!vals.length) return null;
            const q = name === 'MEDIAN' ? 0.5 : toNum(evalExpr(e.args[1], scopeFor(rows[0] || []), env));
            if (q === null || q < 0 || q > 1) throw new Unsupported('quantile');
            if (vals.some(v => v instanceof SqlDate)) throw new Unsupported('median of dates');
            const sorted = nums().sort((x, y) => x - y);
            const pos = q * (sorted.length - 1);
            const lo = Math.floor(pos), hi = Math.ceil(pos);
            return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
        }
        case 'STDDEV': case 'STDDEV_SAMP': case 'STDDEV_POP': case 'VARIANCE': case 'VAR_SAMP': case 'VAR_POP': {
            const n = nums();
            const pop = name.endsWith('_POP');
            if (n.length < (pop ? 1 : 2)) return null;
            const mean = n.reduce((t, x) => t + x, 0) / n.length;
            const variance = n.reduce((t, x) => t + (x - mean) ** 2, 0) / (n.length - (pop ? 0 : 1));
            return name.startsWith('STDDEV') ? Math.sqrt(variance) : variance;
        }
        case 'ARG_MAX': case 'ARGMAX': case 'MAX_BY': case 'ARG_MIN': case 'ARGMIN': case 'MIN_BY': {
            if (!seconds.length) return null;
            const max = /MAX/.test(name);
            let best = 0;
            for (let i = 1; i < seconds.length; i++) if (max ? compareValues(seconds[i], seconds[best]) > 0 : compareValues(seconds[i], seconds[best]) < 0) best = i;
            const ties = seconds.filter(v => compareValues(v, seconds[best]) === 0).length;
            if (ties > 1) env.tieSensitive = true;
            return values[best];
        }
        case 'BOOL_OR': return vals.length ? vals.some(v => truthy(v) === true) : null;
        case 'BOOL_AND': return vals.length ? vals.every(v => truthy(v) === true) : null;
        case 'ANY_VALUE': case 'FIRST': case 'LAST': {
            if (!vals.length) return null;
            if (new Set(vals.map(keyOf)).size > 1) env.tieSensitive = true;
            return name === 'LAST' ? vals[vals.length - 1] : vals[0];
        }
        case 'MODE': {
            if (!vals.length) return null;
            const counts = new Map<string, { v: Value; n: number }>();
            for (const v of vals) { const k = keyOf(v); const c = counts.get(k); if (c) c.n++; else counts.set(k, { v, n: 1 }); }
            const ranked = [...counts.values()].sort((x, y) => y.n - x.n);
            if (ranked.length > 1 && ranked[1].n === ranked[0].n) env.tieSensitive = true;
            return ranked[0].v;
        }
    }
    throw new Unsupported(`aggregate ${name}`);
}

// ── How many rows of the data stand behind each value ──
/** Rows produced by a CTE, subquery or UNION carry the number of data rows behind them; data rows count as one. */
const behind = new WeakMap<Value[], number>();
const rowsBehindOf = (row: Value[]) => behind.get(row) ?? 1;
const scopeBehind = (sc: Scope) => (sc.group ? sc.group.reduce((total, row) => total + rowsBehindOf(row), 0) : rowsBehindOf(sc.row));
/** How many data rows a figure was worked out from: the widest aggregate or window inside it. */
function cellBase(e: Expr, sc: Scope): number {
    switch (e.k) {
        case 'func':
            if (e.over) return sc.winBase?.get(e) ?? 0;
            if (AGGREGATES.has(e.name)) return scopeBehind(sc);
            return Math.max(0, ...e.args.map(a => cellBase(a, sc)));
        case 'col': return behind.has(sc.row) ? rowsBehindOf(sc.row) : 0;
        case 'unary': case 'isnull': case 'cast': return cellBase(e.e, sc);
        case 'bin': return Math.max(cellBase(e.l, sc), cellBase(e.r, sc));
        case 'case': return Math.max(0, ...(e.operand ? [cellBase(e.operand, sc)] : []), ...e.whens.map(w => Math.max(cellBase(w.when, sc), cellBase(w.then, sc))), ...(e.else ? [cellBase(e.else, sc)] : []));
        default: return 0;
    }
}

// ── Windows ──
function computeWindow(node: Extract<Expr, { k: 'func' }>, scopes: Scope[], env: Env): void {
    const spec = node.over!;
    const parts = new Map<string, number[]>();
    scopes.forEach((sc, i) => {
        const key = spec.partition.map(p => keyOf(evalExpr(p, sc, env))).join('\u0001');
        const list = parts.get(key);
        if (list) list.push(i); else parts.set(key, [i]);
    });
    const name = node.name;
    for (const idx of parts.values()) {
        const orderKeys = idx.map(i => spec.order.map(o => evalExpr(o.e, scopes[i], env)));
        const pos = idx.map((_, n) => n);
        if (spec.order.length) pos.sort((x, y) => compareKeyLists(orderKeys[x], orderKeys[y], spec.order));
        const ordered = pos.map(n => idx[n]);
        const keysInOrder = pos.map(n => orderKeys[n]);
        const peerEnd: number[] = new Array(ordered.length);
        for (let i = ordered.length - 1; i >= 0; i--) {
            peerEnd[i] = i < ordered.length - 1 && spec.order.length && compareKeyLists(keysInOrder[i], keysInOrder[i + 1], spec.order) === 0 ? peerEnd[i + 1] : i;
        }
        const set = (n: number, v: Value) => { const sc = scopes[ordered[n]]; (sc.win ||= new Map()).set(node, v); };
        if (name === 'ROW_NUMBER') {
            ordered.forEach((_, n) => set(n, n + 1));
            if (!spec.order.length ? ordered.length > 1 : peerEnd.some((end, n) => end !== n)) env.tieSensitive = true;
            continue;
        }
        if (name === 'RANK' || name === 'DENSE_RANK') {
            let rank = 0, dense = 0;
            ordered.forEach((_, n) => {
                if (n === 0 || compareKeyLists(keysInOrder[n - 1], keysInOrder[n], spec.order) !== 0) { rank = n + 1; dense++; }
                set(n, name === 'RANK' ? rank : dense);
            });
            continue;
        }
        if (name === 'NTILE' || name === 'PERCENT_RANK' || name === 'CUME_DIST' || name === 'NTH_VALUE') throw new Unsupported(name);
        if (name === 'LAG' || name === 'LEAD') {
            if (peerEnd.some((end, n) => end !== n)) env.tieSensitive = true;
            ordered.forEach((_, n) => {
                const sc = scopes[ordered[n]];
                const offset = node.args[1] ? toNum(evalExpr(node.args[1], sc, env)) ?? 1 : 1;
                const j = name === 'LAG' ? n - offset : n + offset;
                set(n, j >= 0 && j < ordered.length ? evalExpr(node.args[0], scopes[ordered[j]], env) : node.args[2] ? evalExpr(node.args[2], sc, env) : null);
            });
            continue;
        }
        if (name === 'FIRST_VALUE' || name === 'LAST_VALUE') {
            ordered.forEach((_, n) => {
                const j = name === 'FIRST_VALUE' ? 0 : spec.order.length ? peerEnd[n] : ordered.length - 1;
                set(n, evalExpr(node.args[0], scopes[ordered[j]], env));
            });
            continue;
        }
        if (!AGGREGATES.has(name)) throw new Unsupported(`window ${name}`);
        // An aggregate over the partition (or the running frame up to the current peers).
        const aggregateOver = (members: number[]): Value => {
            const fake: Extract<Expr, { k: 'func' }> = { ...node, over: undefined };
            const base = scopes[members[0]];
            // Each member's arguments are evaluated in its own scope (it may be a group).
            const rows: Value[][] = members.map(m => [m]);
            const rel: Relation = makeRelation(['__member'], rows);
            const member = (arg: Expr): Expr => (arg.k === 'star' ? arg : { k: 'func', name: '__MEMBER', args: [arg], distinct: false });
            const proxy: Extract<Expr, { k: 'func' }> = { ...fake, args: fake.args.map(member), filter: fake.filter ? member(fake.filter) : undefined };
            const previous = memberScopes;
            memberScopes = scopes;
            try { return evalAggregate(proxy, { rel, row: rows[0], group: rows, aliases: base.aliases }, env); } finally { memberScopes = previous; }
        };
        const setBase = (members: number[], targets: number[]) => {
            const base = members.reduce((total, m) => total + scopeBehind(scopes[m]), 0);
            for (const t of targets) (scopes[ordered[t]].winBase ||= new Map()).set(node, base);
        };
        if (!spec.order.length) {
            const v = aggregateOver(ordered);
            ordered.forEach((_, n) => set(n, v));
            setBase(ordered, ordered.map((_, n) => n));
        } else {
            let n = 0;
            while (n < ordered.length) {
                const end = peerEnd[n];
                const v = aggregateOver(ordered.slice(0, end + 1));
                const targets: number[] = [];
                for (let m = n; m <= end; m++) { set(m, v); targets.push(m); }
                setBase(ordered.slice(0, end + 1), targets);
                n = end + 1;
            }
        }
    }
}
// Window aggregates evaluate each member's arguments in that member's own scope.
let memberScopes: Scope[] = [];

function compareKeyLists(a: Value[], b: Value[], order: OrderItem[]): number {
    for (let i = 0; i < order.length; i++) {
        const x = a[i], y = b[i];
        const nullsFirst = order[i].nullsFirst ?? false;
        if (x === null || y === null) {
            // DuckDB sorts NULLs last in both directions unless told otherwise.
            if (x === null && y === null) continue;
            return (x === null ? 1 : -1) * (nullsFirst ? -1 : 1);
        }
        const c = compareValues(x, y);
        if (c !== 0) return order[i].desc ? -c : c;
    }
    return 0;
}

// ── Queries ──
export function runQuery(q: Query, env: Env): EvalResult {
    const cached = env.subCache.get(q);
    if (cached) return cached;
    // CTEs are visible to the body and to later CTEs.
    const saved = new Map(env.tables);
    for (const cte of q.ctes) {
        const r = runQuery(cte.q, env);
        env.tables.set(cte.name.toLowerCase(), makeRelation(r.cols, r.rows));
    }
    const first = runSelect(q.body, env, q.unions.length ? [] : q.order);
    let cols = first.cols;
    let pairs = first.pairs;
    for (const u of q.unions) {
        const next = runSelect(u.s, env, []);
        if (next.cols.length !== cols.length) throw new Unsupported('UNION of different widths');
        pairs = pairs.concat(next.pairs);
        if (!u.all) pairs = dedupe(pairs);
    }
    // ORDER BY (on the output, or the source scope when there is no UNION/DISTINCT).
    let limitTie = false;
    if (q.order.length) {
        const outIndex = new Map(cols.map((c, i) => [c.toLowerCase(), i] as [string, number]));
        const keyFor = (pair: Pair): Value[] => q.order.map(o => {
            if (o.e.k === 'lit' && typeof o.e.v === 'number' && Number.isInteger(o.e.v)) return pair.out[o.e.v - 1] ?? null;
            if (o.e.k === 'col' && !o.e.table && outIndex.has(o.e.name.toLowerCase()) && !(pair.scope && pair.scope.rel.index.has(o.e.name.toLowerCase()) && !first.aliasNames.has(o.e.name.toLowerCase()))) return pair.out[outIndex.get(o.e.name.toLowerCase())!];
            if (!pair.scope) throw new Unsupported('ORDER BY after UNION');
            return evalExpr(o.e, pair.scope, env);
        });
        const keyed = pairs.map(pair => ({ pair, key: keyFor(pair) }));
        keyed.sort((x, y) => compareKeyLists(x.key, y.key, q.order));
        const start = q.offset || 0;
        const end = q.limit !== undefined ? start + q.limit : keyed.length;
        if (q.limit !== undefined && end < keyed.length && end > 0 && compareKeyLists(keyed[end - 1].key, keyed[end].key, q.order) === 0) limitTie = true;
        if (start > 0 && start < keyed.length && compareKeyLists(keyed[start - 1].key, keyed[start].key, q.order) === 0) limitTie = true;
        pairs = keyed.slice(start, end).map(x => x.pair);
    } else if (q.limit !== undefined || q.offset) {
        // A LIMIT without ORDER BY: any rows would be right.
        const start = q.offset || 0;
        if (start + (q.limit ?? Infinity) < pairs.length || start > 0) limitTie = true;
        pairs = pairs.slice(start, q.limit !== undefined ? start + q.limit : undefined);
    }
    env.tables = saved;
    const result: EvalResult = { cols, rows: pairs.map(p => p.out), limitTie, tieSensitive: env.tieSensitive, rowsUsed: first.rowsUsed, rowsTotal: first.rowsTotal, rowsBehind: pairs.map(p => rowsBehindOf(p.out)), cellBase: pairs.map(p => p.base) };
    env.subCache.set(q, result);
    return result;
}

interface Pair { out: Value[]; scope?: Scope; base: number[] }
function dedupe(pairs: Pair[]): Pair[] {
    const seen = new Set<string>();
    return pairs.filter(p => { const k = p.out.map(keyOf).join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; });
}

function sourceRelation(from: TableRef | undefined, env: Env): Relation {
    if (!from) return makeRelation([], [[]]);
    if (from.k === 'sub') { const r = runQuery(from.q, env); return makeRelation(r.cols, r.rows); }
    const rel = env.tables.get(from.name.toLowerCase());
    if (rel) return rel;
    // The app loads the dataset as "data" and rewrites other names to it
    // (the Builder writes FROM "<dataset name>"); other uploaded tables are not followed.
    if (env.tables.has('data') && !env.otherTables.has(from.name.toLowerCase())) return env.tables.get('data')!;
    throw new Unsupported(`table ${from.name}`);
}

function runSelect(sel: Select, env: Env, order: OrderItem[]): { cols: string[]; pairs: Pair[]; rowsUsed: number; rowsTotal: number; aliasNames: Set<string> } {
    const rel = sourceRelation(sel.from, env);
    const aliases = new Map<string, Expr>();
    for (const item of sel.items) if (item.alias && item.e.k !== 'star' && !containsWindow(item.e)) aliases.set(item.alias.toLowerCase(), item.e);
    const aliasNames = new Set(sel.items.filter(i => i.alias).map(i => i.alias!.toLowerCase()));
    // WHERE: aliases of plain (non-aggregate) expressions may be used, as DuckDB allows.
    const whereAliases = new Map([...aliases].filter(([, e]) => !containsAggregate(e)));
    let rows = rel.rows;
    if (sel.where) {
        const kept: Value[][] = [];
        for (const row of rows) { tick(env); if (truthy(evalExpr(sel.where, { rel, row, aliases: whereAliases }, env)) === true) kept.push(row); }
        rows = kept;
    }
    const rowsUsed = rows.length;
    // Grouping
    const resolveGroupExpr = (g: Expr): Expr => {
        if (g.k === 'lit' && typeof g.v === 'number' && Number.isInteger(g.v)) {
            const item = sel.items[g.v - 1];
            if (!item || item.e.k === 'star') throw new Unsupported('GROUP BY position');
            return item.e;
        }
        if (g.k === 'col' && !g.table && !rel.index.has(g.name.toLowerCase()) && aliases.has(g.name.toLowerCase())) return aliases.get(g.name.toLowerCase())!;
        return g;
    };
    const anyAgg = sel.items.some(i => containsAggregate(i.e)) || containsAggregate(sel.having) || containsAggregate(sel.qualify) || order.some(o => containsAggregate(o.e));
    let scopes: Scope[];
    if (sel.groupBy || anyAgg) {
        const keys: Expr[] = sel.groupBy === 'ALL'
            ? sel.items.filter(i => i.e.k !== 'star' && !containsAggregate(i.e) && !containsWindow(i.e)).map(i => i.e)
            : (sel.groupBy || []).map(resolveGroupExpr);
        if (sel.items.some(i => i.e.k === 'star')) throw new Unsupported('* with GROUP BY');
        const groups = new Map<string, Value[][]>();
        for (const row of rows) {
            tick(env);
            const sc: Scope = { rel, row, aliases: whereAliases };
            const k = keys.map(g => keyOf(evalExpr(g, sc, env))).join('\u0001');
            const list = groups.get(k);
            if (list) list.push(row); else groups.set(k, [row]);
        }
        if (!keys.length && !groups.size) groups.set('', []);
        scopes = [...groups.values()].map(group => ({ rel, row: group[0] || rel.cols.map(() => null), group, aliases }));
        if (sel.having) scopes = scopes.filter(sc => truthy(evalExpr(sel.having!, sc, env)) === true);
    } else {
        scopes = rows.map(row => ({ rel, row, aliases }));
    }
    // Windows
    const windows: Expr[] = [];
    sel.items.forEach(i => collectWindows(i.e, windows));
    collectWindows(sel.qualify, windows);
    order.forEach(o => collectWindows(o.e, windows));
    for (const w of windows) computeWindow(w as Extract<Expr, { k: 'func' }>, scopes, env);
    // Aliases of window expressions can be used in QUALIFY.
    if (sel.qualify) {
        const qualAliases = new Map(aliases);
        for (const item of sel.items) if (item.alias && containsWindow(item.e)) qualAliases.set(item.alias.toLowerCase(), item.e);
        scopes = scopes.filter(sc => truthy(evalExpr(sel.qualify!, { ...sc, aliases: qualAliases }, env)) === true);
    }
    // Projection
    const cols: string[] = [];
    for (const [n, item] of sel.items.entries()) {
        if (item.e.k === 'star') cols.push(...rel.cols);
        else cols.push(item.alias || (item.e.k === 'col' ? item.e.name : `column${n}`));
    }
    let pairs: Pair[] = scopes.map(sc => {
        const out: Value[] = [];
        const outValues = new Map<string, Value>();
        for (const item of sel.items) {
            if (item.e.k === 'star') { out.push(...sc.row); continue; }
            const v = evalExpr(item.e, sc, env);
            out.push(v);
            if (item.alias) outValues.set(item.alias.toLowerCase(), v);
        }
        behind.set(out, scopeBehind(sc));
        const base = sel.items.flatMap(item => (item.e.k === 'star' ? sc.row.map(() => 0) : [cellBase(item.e, sc)]));
        return { out, base, scope: { ...sc, outValues: sc.group || anyAgg ? outValues : undefined } };
    });
    if (sel.distinct) pairs = dedupe(pairs).map(p => ({ out: p.out, base: p.base, scope: undefined }));
    return { cols, pairs, rowsUsed, rowsTotal: rel.rows.length, aliasNames };
}

function containsWindow(e: Expr): boolean {
    const found: Expr[] = [];
    collectWindows(e, found);
    return found.length > 0;
}

/** Run a parsed query over the cleaned rows. Throws Unsupported for anything it cannot work out. */
export function evaluate(q: Query, tables: Record<string, Record<string, any>[]>, budgetMs = 4000, otherTables: string[] = []): EvalResult {
    const env: Env = {
        otherTables: new Set(['dim_date', ...otherTables].map(name => name.toLowerCase())),
        tables: new Map(Object.entries(tables).map(([name, rows]) => [name.toLowerCase(), relationFromRows(rows)])),
        deadline: Date.now() + budgetMs,
        tick: 0,
        tieSensitive: false,
        subCache: new Map(),
    };
    return runQuery(q, env);
}

