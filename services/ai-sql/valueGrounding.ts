/**
 * Value Grounding — the "knob binder" for filters.
 * ─────────────────────────────────────────────────────────────────────
 * The plan layer maps question words to COLUMNS but routinely drops the VALUES
 * ("revenue from Delivery" → the Delivery filter vanishes, especially when the
 * LLM is unavailable and the weak deterministic planner runs). This module
 * grounds question phrases against the dataset's ACTUAL dimension values and
 * recovers the missing filters — deterministically, in-browser, with no LLM and
 * without ever sending values anywhere.
 *
 * Conservative by design: it only grounds distinctive categorical values, uses
 * word-boundary matching, refuses ambiguous matches (a value that belongs to
 * more than one column), and refuses same-field positive+negative matches (that
 * is set/anti-join logic — a separate knob, not a filter).
 */

import type { AnalysisPlan, PlanFilter, SemanticModel } from './types';

export interface ValueCatalog {
    /** Lowercased value → the columns/canonical-values it appears in. */
    index: Map<string, Array<{ field: string; value: string; filterEligible?: boolean }>>;
    /** Columns for which the catalog contains the complete bounded domain. */
    coveredFields: Set<string>;
}

export interface SqlLiteralAuditIssue {
    field: string;
    literal: string;
    operator: '=' | 'LIKE' | 'ILIKE';
}

const NEGATION_CUES = [
    'not ', "n't ", 'never ', 'without ', 'excluding ', 'exclude ', 'except ',
    'other than ', 'apart from ', 'besides ', 'no ',
];

/** True when a negation cue appears shortly before `idx` in the question. */
function isNegated(qLower: string, idx: number): boolean {
    const window = qLower.slice(Math.max(0, idx - 18), idx);
    return NEGATION_CUES.some(c => window.includes(c));
}

/**
 * Build a value catalog from the dataset rows for low-cardinality dimensions.
 * Only categorical dimensions (not metrics, dates, ids) with a modest number of
 * distinct values are catalogued.
 */
export function buildValueCatalog(
    rows: Record<string, any>[],
    model: SemanticModel,
    maxCardinality = 60,
    relatedTables?: Array<{ name: string; rows: Record<string, any>[] }>,
): ValueCatalog {
    const index = new Map<string, Array<{ field: string; value: string; filterEligible?: boolean }>>();
    const coveredFields = new Set<string>();
    if (!rows || rows.length === 0) return { index, coveredFields };

    const dimFields = model.fields.filter(f =>
        f.role === 'dimension'
        && f.physicalType !== 'date'
        && f.semanticType !== 'date'
        && f.semanticType !== 'identifier'
        && (f.distinctCount === undefined || f.distinctCount <= maxCardinality));

    for (const f of dimFields) {
        const seen = new Set<string>();
        for (const row of rows) {
            const raw = row[f.name];
            if (raw === null || raw === undefined) continue;
            const val = String(raw).trim();
            // Distinctive values only: ≥3 chars, not purely numeric.
            if (val.length < 3 || /^-?\d+(\.\d+)?$/.test(val)) continue;
            if (seen.has(val)) continue;
            seen.add(val);
            if (seen.size > maxCardinality) break;
            const key = val.toLowerCase();
            const arr = index.get(key) || [];
            if (!arr.some(a => a.field === f.name)) arr.push({ field: f.name, value: val, filterEligible: true });
            index.set(key, arr);
        }
        if (seen.size <= maxCardinality) coveredFields.add(f.name.toLowerCase());
    }

    // Cover every physical table for post-generation literal correction. This
    // catalog remains entirely in-browser and is never serialized into a prompt.
    for (const table of relatedTables || []) {
        const tableRows = table.rows || [];
        if (!tableRows.length) continue;
        for (const column of Object.keys(tableRows[0] || {})) {
            if (/(?:^|_)(?:id|key|email|phone|address|postcode|zip)$/i.test(column)) continue;
            const distinct = new Map<string, string>();
            for (const row of tableRows) {
                const raw = row[column];
                if (typeof raw !== 'string') continue;
                const value = raw.trim();
                if (value.length < 2 || /^-?\d+(?:\.\d+)?$/.test(value)) continue;
                distinct.set(value.toLowerCase(), value);
                if (distinct.size > maxCardinality) break;
            }
            if (distinct.size === 0 || distinct.size > maxCardinality) continue;
            coveredFields.add(`${table.name}.${column}`.toLowerCase());
            for (const [key, value] of distinct) {
                const field = `${table.name}.${column}`;
                const entries = index.get(key) || [];
                if (!entries.some(entry => entry.field === field)) {
                    entries.push({ field, value, filterEligible: false });
                }
                index.set(key, entries);
            }
        }
    }
    return { index, coveredFields };
}

function unquoteIdentifier(value: string): string {
    return value.trim().replace(/^["`]([^"`]+)["`]$/, '$1');
}

/**
 * Check model-authored equality and LIKE literals against complete local
 * categorical domains. No catalog values are returned or sent to a model: an
 * issue says only that the literal is absent from the referenced field.
 * High-cardinality and otherwise uncovered fields are deliberately ignored.
 */
export function auditSqlLiterals(sql: string, catalog: ValueCatalog): SqlLiteralAuditIssue[] {
    const aliases = new Map<string, string>();
    const tablePattern = /\b(?:from|join)\s+(["`]?[a-z_][\w$]*["`]?)\s+(?:as\s+)?(["`]?[a-z_][\w$]*["`]?)/gi;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tablePattern.exec(sql)) !== null) {
        const table = unquoteIdentifier(tableMatch[1]);
        const alias = unquoteIdentifier(tableMatch[2]);
        if (!/^(?:where|join|on|group|order|having|limit)$/i.test(alias)) {
            aliases.set(alias.toLowerCase(), table);
        }
    }

    const issues: SqlLiteralAuditIssue[] = [];
    const predicatePattern = /(?:(\b["`]?[a-z_][\w$]*["`]?)\s*\.\s*)?(["`]?[a-z_][\w$]*["`]?)\s*(=|like|ilike)\s*'((?:[^']|'')*)'/gi;
    let match: RegExpExecArray | null;
    while ((match = predicatePattern.exec(sql)) !== null) {
        const qualifier = match[1] ? unquoteIdentifier(match[1]) : '';
        const column = unquoteIdentifier(match[2]);
        const operator = match[3].toUpperCase() as '=' | 'LIKE' | 'ILIKE';
        const literal = match[4].replace(/''/g, "'");
        if (!literal || /^\d{4}-\d{2}-\d{2}/.test(literal)) continue;

        const resolvedQualifier = aliases.get(qualifier.toLowerCase()) || qualifier;
        const qualifiedField = resolvedQualifier ? `${resolvedQualifier}.${column}`.toLowerCase() : '';
        const suffix = `.${column.toLowerCase()}`;
        const candidates = qualifiedField && catalog.coveredFields.has(qualifiedField)
            ? [qualifiedField]
            : [...catalog.coveredFields].filter(field => field === column.toLowerCase() || field.endsWith(suffix));
        if (candidates.length !== 1) continue;

        const field = candidates[0];
        const sought = literal.replace(/^%|%$/g, '').toLowerCase();
        const found = [...catalog.index.entries()].some(([value, entries]) =>
            entries.some(entry => entry.field.toLowerCase() === field)
            && (operator === '=' ? value === sought : value.includes(sought))
        );
        if (!found) issues.push({ field, literal, operator });
    }
    return issues;
}

/**
 * Safety pass over LLM-written SQL: correct string literals whose casing or
 * plural form drifted from the real stored value. Only rewrites a literal when
 * its lowercased (or singularised) form maps UNAMBIGUOUSLY to exactly one real
 * catalogued value — it never fabricates or guesses. Fixes "coffee" → "Coffee",
 * "Beverages" → "Beverage"; leaves everything else untouched.
 */
export function groundSqlLiterals(sql: string, catalog: ValueCatalog): { sql: string; changed: string[] } {
    const changed: string[] = [];
    const resolve = (raw: string): string | null => {
        const key = raw.toLowerCase();
        const exact = catalog.index.get(key);
        if (exact && exact.length === 1 && exact[0].value !== raw) return exact[0].value;
        if (exact) return null; // present as-is or ambiguous → leave alone
        // Try singular forms: drop a trailing "s" ("beverages"→"beverage") or
        // "es" ("boxes"→"box"). Whichever resolves unambiguously wins.
        for (const cand of [key.replace(/s$/, ''), key.replace(/es$/, '')]) {
            if (cand === key) continue;
            const sing = catalog.index.get(cand);
            if (sing && sing.length === 1) return sing[0].value;
        }
        return null;
    };
    const out = sql.replace(/'((?:[^']|'')*)'/g, (full, inner: string) => {
        const raw = inner.replace(/''/g, "'");
        const fixed = resolve(raw);
        if (fixed && fixed !== raw) {
            changed.push(`${raw}→${fixed}`);
            return `'${fixed.replace(/'/g, "''")}'`;
        }
        return full;
    });
    return { sql: out, changed };
}

export interface GroundingResult {
    /** Filters recovered from the question that the plan was missing. */
    added: PlanFilter[];
    /** Values that matched more than one column (skipped — ambiguous). */
    ambiguous: string[];
    /** Fields that had both a positive and a negative match (skipped — set logic). */
    setLogicFields: string[];
}

/** Does the plan already constrain `field` by `value` (either polarity)? */
function alreadyFiltered(plan: AnalysisPlan, field: string, value: string): boolean {
    const v = value.toLowerCase();
    return plan.filters.some(f => {
        if (f.field.toLowerCase() !== field.toLowerCase()) return false;
        const fv = Array.isArray(f.value) ? f.value.map(x => String(x).toLowerCase()) : [String(f.value).toLowerCase()];
        return fv.includes(v);
    });
}

/**
 * Ground filters from the question against the value catalog and return the
 * filters the plan is missing. Does NOT mutate the plan.
 */
export function groundFilters(
    question: string,
    catalog: ValueCatalog,
    plan: AnalysisPlan,
    model: SemanticModel,
): GroundingResult {
    const qLower = ` ${question.toLowerCase()} `;
    const added: PlanFilter[] = [];
    const ambiguous: string[] = [];

    // field → { pos: Set<value>, neg: Set<value> }
    const perField = new Map<string, { pos: Set<string>; neg: Set<string> }>();

    for (const [key, entries] of catalog.index) {
        // Whole-phrase, boundary-aware match, tolerant of a trailing plural
        // ("Beverages" matches the value "Beverage").
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`(^|[^a-z0-9])${escaped}(?:s|es)?([^a-z0-9]|$)`, 'i');
        const m = re.exec(qLower);
        if (!m) continue;

        const eligibleEntries = entries.filter(entry => entry.filterEligible !== false);
        if (eligibleEntries.length > 1) { ambiguous.push(key); continue; } // belongs to 2+ plan columns
        if (eligibleEntries.length === 0) continue; // related-table values only correct generated SQL
        const { field, value } = eligibleEntries[0];
        if (alreadyFiltered(plan, field, value)) continue;

        const at = m.index + m[1].length;
        const neg = isNegated(qLower, at);
        const bucket = perField.get(field) || { pos: new Set(), neg: new Set() };
        (neg ? bucket.neg : bucket.pos).add(value);
        perField.set(field, bucket);
    }

    const setLogicFields: string[] = [];
    for (const [field, { pos, neg }] of perField) {
        // Same field with both polarities → anti-join / set logic, not a filter.
        if (pos.size > 0 && neg.size > 0) { setLogicFields.push(field); continue; }
        if (pos.size > 0) {
            added.push(pos.size === 1
                ? { field, op: '=', value: [...pos][0] }
                : { field, op: 'in', value: [...pos] });
        } else if (neg.size > 0) {
            added.push(neg.size === 1
                ? { field, op: '!=', value: [...neg][0] }
                : { field, op: 'not_in', value: [...neg] });
        }
    }

    return { added, ambiguous, setLogicFields };
}
