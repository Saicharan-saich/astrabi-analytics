/**
 * A small reader for the DuckDB SQL the AI writes (and the Builder's own
 * questions, translated). It shares nothing with DuckDB: the answer check uses
 * it to work every figure out a second, independent way.
 *
 * Covers SELECT … FROM one table, a subquery or a CTE; WHERE, GROUP BY (incl.
 * ordinals, aliases and ALL), HAVING, QUALIFY, ORDER BY, LIMIT/OFFSET,
 * UNION [ALL]; expressions, CASE, CAST/TRY_CAST/::, IN/BETWEEN/LIKE/ILIKE,
 * IS [NOT] NULL, scalar and IN subqueries, aggregates with DISTINCT and
 * FILTER (WHERE …), window functions with PARTITION BY / ORDER BY.
 * Anything else (joins, frames, EXISTS…) throws Unsupported — the check then
 * says it could only partly check the answer, never guesses.
 */

export class Unsupported extends Error {
    constructor(public what: string) { super(`not supported: ${what}`); }
}

export type Expr =
    | { k: 'lit'; v: number | string | boolean | null }
    | { k: 'date'; v: string; ts?: boolean }
    | { k: 'interval'; n: number; unit: string }
    | { k: 'col'; name: string; table?: string }
    | { k: 'star' }
    | { k: 'unary'; op: '-' | 'NOT'; e: Expr }
    | { k: 'bin'; op: string; l: Expr; r: Expr }
    | { k: 'isnull'; e: Expr; not: boolean }
    | { k: 'in'; e: Expr; list?: Expr[]; sub?: Query; not: boolean }
    | { k: 'between'; e: Expr; lo: Expr; hi: Expr; not: boolean }
    | { k: 'like'; e: Expr; pat: Expr; ci: boolean; not: boolean }
    | { k: 'case'; operand?: Expr; whens: { when: Expr; then: Expr }[]; else?: Expr }
    | { k: 'cast'; e: Expr; type: string; tryCast: boolean }
    | { k: 'func'; name: string; args: Expr[]; distinct: boolean; filter?: Expr; over?: WindowSpec; extractPart?: string }
    | { k: 'sub'; q: Query };

export interface WindowSpec { partition: Expr[]; order: OrderItem[] }
export interface OrderItem { e: Expr; desc: boolean; nullsFirst?: boolean }
export interface SelectItem { e: Expr; alias?: string }
export type TableRef = { k: 'table'; name: string; alias?: string } | { k: 'sub'; q: Query; alias?: string };
export interface Select {
    distinct: boolean;
    items: SelectItem[];
    from?: TableRef;
    where?: Expr;
    groupBy?: Expr[] | 'ALL';
    having?: Expr;
    qualify?: Expr;
}
export interface Query {
    ctes: { name: string; q: Query }[];
    body: Select;
    unions: { all: boolean; s: Select }[];
    order: OrderItem[];
    limit?: number;
    offset?: number;
}

type Tok = { t: 'id' | 'qid' | 'str' | 'num' | 'op' | 'eof'; v: string };

function tokenize(sql: string): Tok[] {
    const out: Tok[] = [];
    let i = 0;
    while (i < sql.length) {
        const c = sql[i];
        if (/\s/.test(c)) { i++; continue; }
        if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
        if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 2; continue; }
        if (c === "'") {
            let s = ''; i++;
            while (i < sql.length) {
                if (sql[i] === "'" && sql[i + 1] === "'") { s += "'"; i += 2; continue; }
                if (sql[i] === "'") break;
                s += sql[i++];
            }
            i++; out.push({ t: 'str', v: s }); continue;
        }
        if (c === '"') {
            let s = ''; i++;
            while (i < sql.length) {
                if (sql[i] === '"' && sql[i + 1] === '"') { s += '"'; i += 2; continue; }
                if (sql[i] === '"') break;
                s += sql[i++];
            }
            i++; out.push({ t: 'qid', v: s }); continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
            const m = sql.slice(i).match(/^(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?)/i)!;
            out.push({ t: 'num', v: m[0] }); i += m[0].length; continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const m = sql.slice(i).match(/^[A-Za-z_][A-Za-z0-9_$]*/)!;
            out.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
        }
        const two = sql.slice(i, i + 2);
        if (['<>', '!=', '<=', '>=', '||', '::', '//', '=='].includes(two)) { out.push({ t: 'op', v: two === '==' ? '=' : two }); i += 2; continue; }
        if ('(),.*+-/%=<>;'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
        throw new Unsupported(`character ${c}`);
    }
    out.push({ t: 'eof', v: '' });
    return out;
}

const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'QUALIFY', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'ON', 'AS', 'AND', 'OR', 'NOT', 'WINDOW', 'USING', 'EXCEPT', 'INTERSECT', 'ASC', 'DESC', 'NULLS', 'WHEN', 'THEN', 'ELSE', 'END', 'NATURAL', 'POSITIONAL', 'ASOF', 'LATERAL', 'SEMI', 'ANTI']);

export function parseSQL(sql: string): Query {
    const toks = tokenize(sql);
    let p = 0;
    const peek = (o = 0) => toks[Math.min(p + o, toks.length - 1)];
    const isKw = (w: string, o = 0) => peek(o).t === 'id' && peek(o).v.toUpperCase() === w;
    const isOp = (v: string, o = 0) => peek(o).t === 'op' && peek(o).v === v;
    const next = () => toks[p++];
    const eatKw = (w: string) => { if (isKw(w)) { p++; return true; } return false; };
    const eatOp = (v: string) => { if (isOp(v)) { p++; return true; } return false; };
    const needKw = (w: string) => { if (!eatKw(w)) throw new Unsupported(`expected ${w} near "${peek().v}"`); };
    const needOp = (v: string) => { if (!eatOp(v)) throw new Unsupported(`expected ${v} near "${peek().v}"`); };
    const ident = (): string => {
        const t = next();
        if (t.t === 'qid') return t.v;
        if (t.t === 'id') return t.v;
        throw new Unsupported(`name expected near "${t.v}"`);
    };

    function query(): Query {
        const ctes: Query['ctes'] = [];
        if (eatKw('WITH')) {
            if (isKw('RECURSIVE')) throw new Unsupported('recursive query');
            do {
                const name = ident();
                if (isOp('(')) throw new Unsupported('CTE column list');
                needKw('AS');
                if (isKw('MATERIALIZED') || isKw('NOT')) { eatKw('NOT'); eatKw('MATERIALIZED'); }
                needOp('(');
                const q = query();
                needOp(')');
                ctes.push({ name, q });
            } while (eatOp(','));
        }
        const body = selectCore();
        const unions: Query['unions'] = [];
        while (isKw('UNION') || isKw('EXCEPT') || isKw('INTERSECT')) {
            if (!isKw('UNION')) throw new Unsupported(peek().v.toUpperCase());
            p++;
            const all = eatKw('ALL');
            if (isKw('BY')) throw new Unsupported('UNION BY NAME');
            unions.push({ all, s: selectCore() });
        }
        const order: OrderItem[] = [];
        if (isKw('ORDER') && isKw('BY', 1)) { p += 2; order.push(...orderList()); }
        let limit: number | undefined;
        let offset: number | undefined;
        for (let n = 0; n < 2; n++) {
            if (eatKw('LIMIT')) { const t = next(); if (t.t !== 'num') throw new Unsupported('LIMIT expression'); limit = Number(t.v); if (eatOp('%')) throw new Unsupported('LIMIT %'); }
            if (eatKw('OFFSET')) { const t = next(); if (t.t !== 'num') throw new Unsupported('OFFSET expression'); offset = Number(t.v); }
        }
        return { ctes, body, unions, order, limit, offset };
    }

    function orderList(): OrderItem[] {
        const items: OrderItem[] = [];
        do {
            if (isKw('ALL')) throw new Unsupported('ORDER BY ALL');
            const e = expr();
            let desc = false;
            if (eatKw('DESC')) desc = true; else eatKw('ASC');
            let nullsFirst: boolean | undefined;
            if (eatKw('NULLS')) { if (eatKw('FIRST')) nullsFirst = true; else { needKw('LAST'); nullsFirst = false; } }
            items.push({ e, desc, nullsFirst });
        } while (eatOp(','));
        return items;
    }

    function selectCore(): Select {
        if (isOp('(')) throw new Unsupported('parenthesised set operation');
        needKw('SELECT');
        if (isKw('DISTINCT') && isKw('ON', 1)) throw new Unsupported('DISTINCT ON');
        const distinct = eatKw('DISTINCT');
        eatKw('ALL');
        const items: SelectItem[] = [];
        do {
            if (isOp('*')) { p++; if (isKw('EXCLUDE') || isKw('REPLACE') || isKw('COLUMNS')) throw new Unsupported('star modifier'); items.push({ e: { k: 'star' } }); continue; }
            if ((peek().t === 'id' || peek().t === 'qid') && isOp('.', 1) && isOp('*', 2)) { p += 3; items.push({ e: { k: 'star' } }); continue; }
            const e = expr();
            let alias: string | undefined;
            if (eatKw('AS')) alias = ident();
            else if (peek().t === 'qid' || (peek().t === 'id' && !RESERVED.has(peek().v.toUpperCase()))) alias = ident();
            items.push({ e, alias });
        } while (eatOp(','));
        let from: TableRef | undefined;
        if (eatKw('FROM')) {
            from = tableRef();
            if (isOp(',') || isKw('JOIN') || isKw('LEFT') || isKw('RIGHT') || isKw('INNER') || isKw('FULL') || isKw('CROSS') || isKw('NATURAL') || isKw('ASOF') || isKw('POSITIONAL') || isKw('SEMI') || isKw('ANTI')) throw new Unsupported('join');
        }
        let where: Expr | undefined;
        if (eatKw('WHERE')) where = expr();
        let groupBy: Select['groupBy'];
        if (isKw('GROUP') && isKw('BY', 1)) {
            p += 2;
            if (eatKw('ALL')) groupBy = 'ALL';
            else {
                if (isKw('ROLLUP') || isKw('CUBE') || isKw('GROUPING')) throw new Unsupported('grouping sets');
                groupBy = [];
                do groupBy.push(expr()); while (eatOp(','));
            }
        }
        let having: Expr | undefined;
        if (eatKw('HAVING')) having = expr();
        if (isKw('WINDOW')) throw new Unsupported('named window');
        let qualify: Expr | undefined;
        if (eatKw('QUALIFY')) qualify = expr();
        return { distinct, items, from, where, groupBy, having, qualify };
    }

    function tableRef(): TableRef {
        let ref: TableRef;
        if (eatOp('(')) {
            const q = query();
            needOp(')');
            ref = { k: 'sub', q };
        } else {
            let name = ident();
            if (eatOp('.')) name = ident(); // schema.table
            if (isOp('(')) throw new Unsupported('table function');
            ref = { k: 'table', name };
        }
        if (eatKw('AS')) ref.alias = ident();
        else if (peek().t === 'qid' || (peek().t === 'id' && !RESERVED.has(peek().v.toUpperCase()))) ref.alias = ident();
        if (isOp('(')) throw new Unsupported('table alias column list');
        return ref;
    }

    // ── Expressions (lowest to highest precedence) ──
    function expr(): Expr { return or(); }
    function or(): Expr {
        let l = and();
        while (eatKw('OR')) l = { k: 'bin', op: 'OR', l, r: and() };
        return l;
    }
    function and(): Expr {
        let l = not();
        while (eatKw('AND')) l = { k: 'bin', op: 'AND', l, r: not() };
        return l;
    }
    function not(): Expr {
        if (eatKw('NOT')) return { k: 'unary', op: 'NOT', e: not() };
        return predicate();
    }
    function predicate(): Expr {
        let l = concat();
        for (;;) {
            if (peek().t === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(peek().v)) {
                const op = next().v;
                if (isKw('ANY') || isKw('ALL') || isKw('SOME')) throw new Unsupported('ANY/ALL comparison');
                l = { k: 'bin', op: op === '!=' ? '<>' : op, l, r: concat() };
                continue;
            }
            if (isKw('IS')) {
                p++;
                const negate = eatKw('NOT');
                if (eatKw('NULL')) { l = { k: 'isnull', e: l, not: negate }; continue; }
                if (eatKw('TRUE')) { l = { k: 'bin', op: negate ? 'ISNOTTRUE' : 'ISTRUE', l, r: { k: 'lit', v: true } }; continue; }
                if (eatKw('FALSE')) { l = { k: 'bin', op: negate ? 'ISNOTFALSE' : 'ISFALSE', l, r: { k: 'lit', v: false } }; continue; }
                if (eatKw('DISTINCT')) { needKw('FROM'); l = { k: 'bin', op: negate ? 'NOTDISTINCT' : 'DISTINCT', l, r: concat() }; continue; }
                throw new Unsupported('IS …');
            }
            if (isKw('ISNULL')) { p++; l = { k: 'isnull', e: l, not: false }; continue; }
            if (isKw('NOTNULL')) { p++; l = { k: 'isnull', e: l, not: true }; continue; }
            const negate = isKw('NOT') && (isKw('IN', 1) || isKw('BETWEEN', 1) || isKw('LIKE', 1) || isKw('ILIKE', 1) || isKw('SIMILAR', 1) || isKw('GLOB', 1));
            if (negate) p++;
            if (eatKw('IN')) {
                needOp('(');
                if (isKw('SELECT') || isKw('WITH')) { const q = query(); needOp(')'); l = { k: 'in', e: l, sub: q, not: negate }; continue; }
                const list: Expr[] = [];
                if (!isOp(')')) do list.push(expr()); while (eatOp(','));
                needOp(')');
                l = { k: 'in', e: l, list, not: negate };
                continue;
            }
            if (eatKw('BETWEEN')) {
                const lo = concat(); needKw('AND'); const hi = concat();
                l = { k: 'between', e: l, lo, hi, not: negate };
                continue;
            }
            if (isKw('LIKE') || isKw('ILIKE')) {
                const ci = next().v.toUpperCase() === 'ILIKE';
                const pat = concat();
                if (isKw('ESCAPE')) throw new Unsupported('LIKE ESCAPE');
                l = { k: 'like', e: l, pat, ci, not: negate };
                continue;
            }
            if (isKw('SIMILAR') || isKw('GLOB')) throw new Unsupported(peek().v);
            if (negate) throw new Unsupported('NOT …');
            return l;
        }
    }
    function concat(): Expr {
        let l = additive();
        while (isOp('||')) { p++; l = { k: 'bin', op: '||', l, r: additive() }; }
        return l;
    }
    function additive(): Expr {
        let l = multiplicative();
        while (isOp('+') || isOp('-')) { const op = next().v; l = { k: 'bin', op, l, r: multiplicative() }; }
        return l;
    }
    function multiplicative(): Expr {
        let l = unary();
        while (isOp('*') || isOp('/') || isOp('%') || isOp('//')) { const op = next().v; l = { k: 'bin', op, l, r: unary() }; }
        return l;
    }
    function unary(): Expr {
        if (eatOp('-')) return { k: 'unary', op: '-', e: unary() };
        if (eatOp('+')) return unary();
        return postfix();
    }
    function postfix(): Expr {
        let e = primary();
        while (isOp('::')) { p++; e = { k: 'cast', e, type: typeName(), tryCast: false }; }
        if (isOp('[')) throw new Unsupported('subscript');
        return e;
    }
    function typeName(): string {
        let name = ident().toUpperCase();
        if (name === 'DOUBLE' && isKw('PRECISION')) { p++; }
        if (eatOp('(')) { while (!isOp(')') && peek().t !== 'eof') p++; needOp(')'); }
        if (isOp('[')) throw new Unsupported('list type');
        if (name === 'TIMESTAMP' && (isKw('WITH') || isKw('WITHOUT'))) throw new Unsupported('time zone type');
        return name;
    }
    function primary(): Expr {
        const t = peek();
        if (t.t === 'num') { p++; return { k: 'lit', v: Number(t.v) }; }
        if (t.t === 'str') { p++; return { k: 'lit', v: t.v }; }
        if (eatOp('(')) {
            if (isKw('SELECT') || isKw('WITH')) { const q = query(); needOp(')'); return { k: 'sub', q }; }
            const e = expr();
            if (isOp(',')) throw new Unsupported('row value');
            needOp(')');
            return e;
        }
        if (t.t === 'qid') {
            p++;
            if (eatOp('.')) return { k: 'col', table: t.v, name: ident() };
            return { k: 'col', name: t.v };
        }
        if (t.t !== 'id') throw new Unsupported(`unexpected "${t.v}"`);
        const up = t.v.toUpperCase();
        if (up === 'NULL') { p++; return { k: 'lit', v: null }; }
        if (up === 'TRUE' || up === 'FALSE') { p++; return { k: 'lit', v: up === 'TRUE' }; }
        if ((up === 'DATE' || up === 'TIMESTAMP') && peek(1).t === 'str') { p += 2; return { k: 'date', v: toks[p - 1].v, ts: up === 'TIMESTAMP' }; }
        if (up === 'INTERVAL') {
            p++;
            let n: number; let unit: string;
            if (peek().t === 'str') {
                const m = next().v.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-z]+)?$/i);
                if (!m) throw new Unsupported('interval text');
                n = Number(m[1]); unit = (m[2] || (peek().t === 'id' ? ident() : '')).toLowerCase();
            } else if (peek().t === 'num') { n = Number(next().v); unit = ident().toLowerCase(); }
            else if (eatOp('(')) { const inner = expr(); needOp(')'); if (inner.k !== 'lit' || typeof inner.v !== 'number') throw new Unsupported('interval expression'); n = inner.v; unit = ident().toLowerCase(); }
            else throw new Unsupported('interval');
            return { k: 'interval', n, unit: unit.replace(/s$/, '') };
        }
        if (up === 'CASE') {
            p++;
            let operand: Expr | undefined;
            if (!isKw('WHEN')) operand = expr();
            const whens: { when: Expr; then: Expr }[] = [];
            while (eatKw('WHEN')) { const when = expr(); needKw('THEN'); whens.push({ when, then: expr() }); }
            let els: Expr | undefined;
            if (eatKw('ELSE')) els = expr();
            needKw('END');
            return { k: 'case', operand, whens, else: els };
        }
        if ((up === 'CAST' || up === 'TRY_CAST') && isOp('(', 1)) {
            p += 2;
            const e = expr(); needKw('AS'); const type = typeName(); needOp(')');
            return { k: 'cast', e, type, tryCast: up === 'TRY_CAST' };
        }
        if (up === 'EXTRACT' && isOp('(', 1)) {
            p += 2;
            const part = peek().t === 'str' ? next().v : ident();
            needKw('FROM');
            const e = expr(); needOp(')');
            return { k: 'func', name: 'DATE_PART', args: [{ k: 'lit', v: part.toLowerCase() }, e], distinct: false };
        }
        if (up === 'EXISTS') throw new Unsupported('EXISTS');
        if (up === 'CURRENT_DATE' || up === 'CURRENT_TIMESTAMP' || up === 'NOW') throw new Unsupported('today\'s date');
        // A function call?
        if (isOp('(', 1)) {
            p += 2;
            const name = up;
            const args: Expr[] = [];
            let distinct = false;
            if (isOp('*') && isOp(')', 1)) { p++; args.push({ k: 'star' }); }
            else if (!isOp(')')) {
                distinct = eatKw('DISTINCT');
                eatKw('ALL');
                do {
                    args.push(expr());
                    if (isKw('ORDER') && isKw('BY', 1)) throw new Unsupported('ordered aggregate');
                } while (eatOp(','));
            }
            needOp(')');
            if (isKw('WITHIN')) throw new Unsupported('WITHIN GROUP');
            if (isKw('IGNORE') || isKw('RESPECT')) throw new Unsupported('IGNORE NULLS');
            let filter: Expr | undefined;
            if (isKw('FILTER') && isOp('(', 1)) { p += 2; eatKw('WHERE'); filter = expr(); needOp(')'); }
            let over: WindowSpec | undefined;
            if (eatKw('OVER')) {
                needOp('(');
                const partition: Expr[] = [];
                let order: OrderItem[] = [];
                if (isKw('PARTITION') && isKw('BY', 1)) { p += 2; do partition.push(expr()); while (eatOp(',')); }
                if (isKw('ORDER') && isKw('BY', 1)) { p += 2; order = orderList(); }
                if (isKw('ROWS') || isKw('RANGE') || isKw('GROUPS')) throw new Unsupported('window frame');
                needOp(')');
                over = { partition, order };
            }
            return { k: 'func', name, args, distinct, filter, over };
        }
        // A column, maybe table-qualified.
        p++;
        if (isOp('.')) { p++; return { k: 'col', table: t.v, name: ident() }; }
        if (RESERVED.has(up)) throw new Unsupported(`unexpected ${up}`);
        return { k: 'col', name: t.v };
    }

    const q = query();
    eatOp(';');
    if (peek().t !== 'eof') throw new Unsupported(`unexpected "${peek().v}"`);
    return q;
}
