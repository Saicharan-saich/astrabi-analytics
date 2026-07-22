/**
 * Anti-join knob — set logic on a single table.
 * ─────────────────────────────────────────────────────────────────────
 * Answers "which <entity> did X but never Y" — e.g. "customers who bought
 * Coffee but never Tea". This is the relational shape the base builder can't
 * express (it needs NOT EXISTS / anti-join), so it gets its own deterministic
 * template. Detection reuses the value catalog: a single filter column that
 * carries BOTH a positive value ("Coffee") and a negated value ("never Tea")
 * signals set logic; the entity to list is resolved from the question.
 *
 *   SELECT DISTINCT entity
 *   FROM data
 *   WHERE filter IN (hasValues)
 *     AND entity NOT IN (SELECT entity FROM data WHERE filter IN (notValues))
 */

import type { SemanticModel } from './types';
import type { ValueCatalog } from './valueGrounding';

export interface AntiJoinSpec {
    /** Column to list (DISTINCT) — the entity the question asks about. */
    entity: string;
    /** Column holding the set values. */
    filterField: string;
    /** Values the entity must have (at least one row). */
    hasValues: string[];
    /** Values the entity must NOT have (zero rows). */
    notValues: string[];
}

const NEGATION_CUES = ['not ', "n't ", 'never ', 'without ', 'excluding ', 'exclude ', 'except ', 'other than '];

function matchedNegated(qLower: string, key: string): { matched: boolean; negated: boolean } {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9])${escaped}(?:s|es)?([^a-z0-9]|$)`, 'i');
    const m = re.exec(qLower);
    if (!m) return { matched: false, negated: false };
    const at = m.index + m[1].length;
    const window = qLower.slice(Math.max(0, at - 18), at);
    return { matched: true, negated: NEGATION_CUES.some(c => window.includes(c)) };
}

/** Resolve the entity column the question is listing (e.g. "customers" → customer_id). */
function resolveEntity(question: string, model: SemanticModel, exclude: string): string | null {
    const q = ` ${question.toLowerCase()} `;
    const candidates = model.fields.filter(f => f.name.toLowerCase() !== exclude.toLowerCase());

    // Match a column whose base noun (customer_id → "customer") appears in the
    // question; prefer identifier columns for a clean DISTINCT list.
    const scored: Array<{ name: string; score: number }> = [];
    for (const f of candidates) {
        const base = f.name.toLowerCase().replace(/_(id|name|key|code)$/, '').replace(/_/g, ' ').trim();
        if (base.length < 3) continue;
        if (q.includes(` ${base}`)) {
            let score = 1;
            if (f.semanticType === 'identifier' || /_id$/.test(f.name.toLowerCase())) score += 2;
            scored.push({ name: f.name, score });
        }
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) return scored[0].name;

    // Fallback: the first identifier column.
    const idField = candidates.find(f => f.semanticType === 'identifier' || /_id$/.test(f.name.toLowerCase()));
    return idField ? idField.name : null;
}

/**
 * Detect an anti-join question. Returns a spec, or null when it isn't one.
 */
export function detectAntiJoin(
    question: string,
    catalog: ValueCatalog,
    model: SemanticModel,
): AntiJoinSpec | null {
    const qLower = ` ${question.toLowerCase()} `;
    // field → { pos, neg }
    const perField = new Map<string, { pos: Set<string>; neg: Set<string> }>();

    for (const [key, entries] of catalog.index) {
        if (entries.length !== 1) continue; // ambiguous value — skip
        const { matched, negated } = matchedNegated(qLower, key);
        if (!matched) continue;
        const { field, value } = entries[0];
        const b = perField.get(field) || { pos: new Set(), neg: new Set() };
        (negated ? b.neg : b.pos).add(value);
        perField.set(field, b);
    }

    // A set-logic field has both polarities.
    for (const [field, { pos, neg }] of perField) {
        if (pos.size === 0 || neg.size === 0) continue;
        const entity = resolveEntity(question, model, field);
        if (!entity || entity.toLowerCase() === field.toLowerCase()) continue;
        return { entity, filterField: field, hasValues: [...pos], notValues: [...neg] };
    }
    return null;
}

function esc(v: string): string {
    return `'${String(v).replace(/'/g, "''")}'`;
}

export function buildAntiJoinSQL(spec: AntiJoinSpec, table = 'data'): string {
    const t = `"${table.replace(/"/g, '""')}"`;
    const entity = `"${spec.entity.replace(/"/g, '""')}"`;
    const filter = `"${spec.filterField.replace(/"/g, '""')}"`;
    const hasList = spec.hasValues.map(esc).join(', ');
    const notList = spec.notValues.map(esc).join(', ');
    return [
        `SELECT DISTINCT ${entity}`,
        `FROM ${t}`,
        `WHERE ${filter} IN (${hasList})`,
        `  AND ${entity} NOT IN (SELECT ${entity} FROM ${t} WHERE ${filter} IN (${notList}))`,
        `ORDER BY ${entity}`,
    ].join('\n');
}
