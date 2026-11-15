/**
 * storedTypeFix.ts — make a query fit how each column is really stored.
 *
 * Files keep yes/no answers as text ("Yes"/"No") or 0/1, and dates as text
 * ('2025-03-01'). The AI is told this, but sometimes writes the query as if
 * the column were a true/false or a real date — COUNT_IF("sla_met"),
 * DATE_TRUNC('month', "opened_date") — which DuckDB refuses. Rather than pay
 * for another AI call to repair it, the query is adjusted here, before it
 * runs, using only column names and how they are stored (never values).
 *
 * Every rewrite keeps the meaning: a yes/no column used as a condition
 * becomes the same test the AI was told to use, and a text date used in date
 * maths is converted to a date first. Anything not recognised is left alone.
 */

export type YesNoStorage = 'boolean' | 'number' | 'text';

export interface StoredTypes {
    /** Yes/no columns and how they are stored. */
    yesNo: Map<string, YesNoStorage>;
    /** Columns holding dates as text, and what to convert them to. */
    textDates: Map<string, 'DATE' | 'TIMESTAMP'>;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quoted = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** A reference to the column: "name", alias."name", or a plain name. */
function refPattern(name: string): string {
    const q = escapeRe(quoted(name));
    const plain = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `|(?<![\\w".])${escapeRe(name)}(?![\\w"])` : '';
    return `(?:(?:[A-Za-z_][\\w]*|"[^"]+")\\.)?(?:${q}${plain})`;
}

/** The test the AI was told to use for a yes/no column. */
export function yesTest(ref: string, storage: YesNoStorage): string {
    if (storage === 'number') return `(${ref} = 1)`;
    if (storage === 'text') return `(LOWER(CAST(${ref} AS VARCHAR)) IN ('yes','y','true','t','1'))`;
    return ref;
}

const BOOLEAN_AGGREGATES = 'COUNT_IF|BOOL_AND|BOOL_OR|EVERY|LOGICAL_AND|LOGICAL_OR';
const NUMERIC_TYPES = 'INT|INTEGER|BIGINT|SMALLINT|TINYINT|HUGEINT|DOUBLE|FLOAT|REAL|DECIMAL(?:\\s*\\(\\s*\\d+\\s*(?:,\\s*\\d+\\s*)?\\))?|NUMERIC|BOOLEAN|BOOL';
const CONDITION_BEFORE = '\\b(?:WHERE|AND|OR|WHEN|HAVING|ON)\\s+';
const CONDITION_AFTER = '(?=\\s*(?:\\)|\\bAND\\b|\\bOR\\b|\\bTHEN\\b|\\bGROUP\\b|\\bORDER\\b|\\bLIMIT\\b|\\bHAVING\\b|\\bQUALIFY\\b|\\bWINDOW\\b|\\bUNION\\b|;|$))';

function fixYesNo(sql: string, name: string, storage: YesNoStorage): string {
    if (storage === 'boolean') return sql;
    const ref = refPattern(name);
    let out = sql;
    // COUNT_IF("col"), BOOL_OR("col") …
    out = out.replace(new RegExp(`\\b(${BOOLEAN_AGGREGATES})\\s*\\(\\s*(${ref})\\s*\\)`, 'gi'), (_m, fn, r) => `${fn}(${yesTest(r, storage)})`);
    // "col" = TRUE / IS FALSE / <> TRUE …
    out = out.replace(new RegExp(`(${ref})\\s*(=|<>|!=|IS\\s+NOT|IS)\\s*(TRUE|FALSE)\\b`, 'gi'), (_m, r, op, value) => {
        const negate = /^(<>|!=|IS\s+NOT)$/i.test(op.trim()) !== /^FALSE$/i.test(value);
        return negate ? `NOT ${yesTest(r, storage)}` : yesTest(r, storage);
    });
    if (storage === 'text') {
        // CAST("col" AS INTEGER), "col"::INT, CAST("col" AS BOOLEAN)
        out = out.replace(new RegExp(`\\bCAST\\s*\\(\\s*(${ref})\\s+AS\\s+(${NUMERIC_TYPES})\\s*\\)`, 'gi'), (_m, r, type) => `CAST(${yesTest(r, storage)} AS ${type})`);
        out = out.replace(new RegExp(`(${ref})\\s*::\\s*(${NUMERIC_TYPES})\\b`, 'gi'), (_m, r, type) => `${yesTest(r, storage)}::${type}`);
        // SUM("col") / AVG("col") on Yes/No text: count or share of yes.
        out = out.replace(new RegExp(`\\b(SUM|AVG)\\s*\\(\\s*(${ref})\\s*\\)`, 'gi'), (_m, fn, r) => `${fn}(CAST(${yesTest(r, storage)} AS INTEGER))`);
    }
    // NOT "col"
    out = out.replace(new RegExp(`\\bNOT\\s+(${ref})(?!\\s*(?:=|<|>|!|\\bIS\\b|\\bIN\\b|\\bLIKE\\b|\\bILIKE\\b|\\bBETWEEN\\b))`, 'gi'), (_m, r) => `NOT ${yesTest(r, storage)}`);
    // WHERE "col" / AND "col" / WHEN "col" THEN …
    out = out.replace(new RegExp(`(${CONDITION_BEFORE})(${ref})${CONDITION_AFTER}`, 'gi'), (_m, before, r) => `${before}${yesTest(r, storage)}`);
    return out;
}

const DATE_FUNCTIONS = 'DATE_TRUNC|DATETRUNC|DATE_PART|DATEPART|DATE_DIFF|DATEDIFF|DATE_SUB|DATESUB|DATE_ADD|STRFTIME|YEAR|MONTH|DAY|QUARTER|WEEK|WEEKOFYEAR|YEARWEEK|DAYOFWEEK|DAYOFMONTH|DAYOFYEAR|ISODOW|ISOYEAR|DAYNAME|MONTHNAME|LAST_DAY|HOUR|MINUTE|EPOCH|AGE|TIME_BUCKET';

/** The end of the call whose "(" is at `open`, or -1. */
function closingParen(sql: string, open: number): number {
    let depth = 0;
    let quote: string | null = null;
    for (let i = open; i < sql.length; i++) {
        const ch = sql[i];
        if (quote) { if (ch === quote) quote = null; continue; }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function castBare(text: string, ref: string, target: string): string {
    // Leave references that are already converted: CAST("col" AS …) or "col"::…
    return text.replace(new RegExp(`(CAST\\s*\\(\\s*|TRY_CAST\\s*\\(\\s*)?(${ref})(\\s*::)?`, 'gi'), (m, castBefore, r, castAfter) =>
        castBefore || castAfter ? m : `CAST(${r} AS ${target})`);
}

function fixTextDate(sql: string, name: string, target: 'DATE' | 'TIMESTAMP'): string {
    const ref = refPattern(name);
    let out = sql;
    // Inside date functions: DATE_TRUNC('month', "col"), YEAR("col"), STRFTIME("col", '%Y-%m') …
    const fnRe = new RegExp(`\\b(?:${DATE_FUNCTIONS})\\s*\\(`, 'gi');
    let match: RegExpExecArray | null;
    let rebuilt = '';
    let cursor = 0;
    while ((match = fnRe.exec(out))) {
        const open = match.index + match[0].length - 1;
        const close = closingParen(out, open);
        if (close < 0) break;
        rebuilt += out.slice(cursor, open + 1) + castBare(out.slice(open + 1, close), ref, target);
        cursor = close;
        fnRe.lastIndex = close;
    }
    out = rebuilt + out.slice(cursor);
    // EXTRACT(MONTH FROM "col")
    out = out.replace(new RegExp(`\\bEXTRACT\\s*\\(\\s*(\\w+)\\s+FROM\\s+(${ref})\\s*\\)`, 'gi'), (_m, part, r) => `EXTRACT(${part} FROM CAST(${r} AS ${target}))`);
    // Compared with a real date: "col" >= DATE '2025-01-01', "col" < CURRENT_DATE, "col" BETWEEN DATE …
    const dateValue = `(?:DATE|TIMESTAMP)\\s*'|CURRENT_DATE|CURRENT_TIMESTAMP|NOW\\s*\\(|TODAY\\s*\\(`;
    out = out.replace(new RegExp(`(CAST\\s*\\(\\s*)?(${ref})(\\s*(?:>=|<=|<>|!=|=|<|>|BETWEEN)\\s*(?:${dateValue}))`, 'gi'), (m, castBefore, r, rest) =>
        castBefore ? m : `CAST(${r} AS ${target})${rest}`);
    out = out.replace(new RegExp(`((?:DATE|TIMESTAMP)\\s*'[^']*'|CURRENT_DATE|CURRENT_TIMESTAMP)(\\s*(?:>=|<=|<>|!=|=|<|>)\\s*)(${ref})(?!\\s*::)`, 'gi'), (_m, value, op, r) => `${value}${op}CAST(${r} AS ${target})`);
    // Date arithmetic: "col" + INTERVAL 7 DAY, "col" - "other_date"
    out = out.replace(new RegExp(`(CAST\\s*\\(\\s*)?(${ref})(\\s*[-+]\\s*INTERVAL\\b)`, 'gi'), (m, castBefore, r, rest) => castBefore ? m : `CAST(${r} AS ${target})${rest}`);
    return out;
}

/**
 * The query adjusted to how the columns are stored, and which columns were
 * adjusted (empty when nothing changed).
 */
export function fitToStoredTypes(sql: string, types: StoredTypes): { sql: string; adjusted: string[] } {
    let out = sql;
    const adjusted: string[] = [];
    for (const [name, storage] of types.yesNo) {
        const next = fixYesNo(out, name, storage);
        if (next !== out) { adjusted.push(name); out = next; }
    }
    for (const [name, target] of types.textDates) {
        const next = fixTextDate(out, name, target);
        if (next !== out) { adjusted.push(name); out = next; }
    }
    return { sql: out, adjusted };
}
