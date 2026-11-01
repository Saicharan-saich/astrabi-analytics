/**
 * Reads, from the SQL that produced a column, whether a percentage was already
 * multiplied by 100 ("points": 12.5 = 12.5%) or left as a fraction (0.125).
 * Charts cannot tell 0.5% stored as 0.5 from 50% stored as 0.5 by looking at
 * the values, but the SQL says which one it computed.
 */
import type { PercentScale } from './percentScale';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text of the SELECT item that is aliased as `alias`, or null. */
export function selectItemFor(sql: string, alias: string): string | null {
    if (!sql || !alias) return null;
    const re = new RegExp(`\\bAS\\s+(?:"${escape(alias)}"|\`${escape(alias)}\`|\\[${escape(alias)}\\]|${escape(alias)}\\b)`, 'gi');
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    // The outermost (last) definition wins: CTEs come before the final SELECT.
    while ((match = re.exec(sql))) last = match;
    if (!last) return null;
    // Walk back to the start of this select item: a comma or SELECT at depth 0.
    let depth = 0;
    let i = last.index - 1;
    for (; i >= 0; i--) {
        const ch = sql[i];
        if (ch === ')') depth++;
        else if (ch === '(') { if (depth === 0) break; depth--; }
        else if (ch === ',' && depth === 0) break;
        else if (depth === 0 && /select\s*$/i.test(sql.slice(Math.max(0, i - 6), i + 1)) && /\s/.test(sql[i + 1] || ' ')) break;
    }
    return sql.slice(i + 1, last.index).trim();
}

/** 'points' when the expression multiplies by 100, 'fraction' when it divides without doing so. */
export function percentScaleFromSql(sql: string | undefined, alias: string | undefined): PercentScale | null {
    if (!sql || !alias) return null;
    const item = selectItemFor(sql, alias);
    if (!item) return null;
    if (/(?:\*\s*100(?:\.0+)?\b|\b100(?:\.0+)?\s*\*)/.test(item)) return 'points';
    if (/\//.test(item) || /\bnullif\s*\(/i.test(item)) return 'fraction';
    return null;
}
