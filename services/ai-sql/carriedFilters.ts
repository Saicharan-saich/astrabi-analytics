/**
 * Filters carried over from the last answer without being asked for.
 *
 * A follow-up starts from the previous query. "Now by month" should keep its
 * filters; "Which departments are over budget?" is a new, complete question
 * and should look at all the data. When the new query still limits rows to
 * values that only the earlier query chose (department IN ('Operations',
 * 'Marketing')), and the new message neither names those values nor points
 * back ("these", "those", "same", "only", "what about"…), the filter was
 * carried over by mistake. SQL text and the question only: no data values.
 */

export interface CarriedFilter {
    column: string;
    values: string[];
}

/** Words that point back to the earlier answer, so keeping its filters is right. */
const POINTS_BACK = /\b(these|those|them|this|that|it|its|same|now|also|again|instead|only|just|still|as well|too|what about|how about|and for|for them|of them|break (?:it|that|this) down|drill|zoom|split (?:it|that|this))\b/i;

const unquote = (text: string) => text.replace(/^"|"$/g, '').replace(/""/g, '"');

/** Text-value filters in a query's WHERE and HAVING: column → values. */
export function textFilters(sql: string): CarriedFilter[] {
    const out = new Map<string, Set<string>>();
    const add = (column: string, value: string) => {
        const key = unquote(column).toLowerCase();
        if (!out.has(key)) out.set(key, new Set());
        out.get(key)!.add(value.replace(/''/g, "'"));
    };
    const body = sql.replace(/--[^\n]*/g, ' ');
    // "col" = 'x', LOWER("col") = LOWER('x'), "col" IN ('a', 'b'), "col" ILIKE '%x%'
    const column = String.raw`(?:LOWER\s*\(\s*)?("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_]*)\s*\)?`;
    const literal = String.raw`(?:LOWER\s*\(\s*)?'((?:[^']|'')*)'\s*\)?`;
    for (const m of body.matchAll(new RegExp(`${column}\\s*(?:=|<>|!=|I?LIKE)\\s*${literal}`, 'gi'))) add(m[1], m[2].replace(/%/g, ''));
    for (const m of body.matchAll(new RegExp(`${column}\\s+(?:NOT\\s+)?IN\\s*\\(([^)]*)\\)`, 'gi'))) {
        for (const v of m[2].matchAll(/'((?:[^']|'')*)'/g)) add(m[1], v[1]);
    }
    return [...out.entries()].map(([col, values]) => ({ column: col, values: [...values].filter(Boolean) })).filter(f => f.values.length);
}

/** Filters in the new query that came only from the earlier one, if the new message did not ask for them. */
export function carriedFilters(question: string, newSql: string, earlierSql: string | undefined): CarriedFilter[] {
    if (!earlierSql || POINTS_BACK.test(question)) return [];
    const earlier = textFilters(earlierSql);
    const asked = question.toLowerCase();
    return textFilters(newSql).flatMap(filter => {
        const before = earlier.find(f => f.column === filter.column);
        if (!before) return [];
        const kept = filter.values.filter(value => before.values.some(v => v.toLowerCase() === value.toLowerCase()) && !asked.includes(value.toLowerCase()));
        return kept.length ? [{ column: filter.column, values: kept }] : [];
    });
}

export const describeCarried = (filters: CarriedFilter[]) =>
    filters.map(f => `${f.column.replace(/_/g, ' ')} ${f.values.length === 1 ? `is ${f.values[0]}` : `is ${f.values.slice(0, -1).join(', ')} or ${f.values[f.values.length - 1]}`}`).join('; ');

/** Sent back to the AI when a filter was carried over without being asked for. */
export function carriedFilterRepair(filters: CarriedFilter[]): string {
    return `Your query keeps a filter from the earlier answer (only rows where ${describeCarried(filters)}), but the new message is a complete question that does not ask for it. Answer it over all the data: drop filters the new message does not ask for.`;
}

/** Filters the new query shares with the earlier one (kept on purpose or not), to say so on the answer. */
export function keptFilters(newSql: string, earlierSql: string | undefined): CarriedFilter[] {
    if (!earlierSql) return [];
    const earlier = textFilters(earlierSql);
    return textFilters(newSql).flatMap(filter => {
        const before = earlier.find(f => f.column === filter.column);
        const kept = before ? filter.values.filter(value => before.values.some(v => v.toLowerCase() === value.toLowerCase())) : [];
        return kept.length ? [{ column: filter.column, values: kept }] : [];
    });
}
