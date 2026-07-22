/**
 * Schema serializer for the direct SQL-semantics engine.
 * ─────────────────────────────────────────────────────────────────────
 * Produces a compact, METADATA-ONLY description of a database (table + column
 * names, inferred types, and foreign keys) to hand to the LLM. No row values are
 * ever included — the privacy guarantee is identical to the plan engine's.
 */

import type { SemanticModel, SemanticField } from './types';

export interface SchemaTable { name: string; rows: Record<string, any>[]; }
export interface SchemaEdge { leftTable: string; rightTable: string; leftColumn: string; rightColumn: string; }

function inferType(rows: Record<string, any>[], col: string): string {
    let sawNumber = false, sawDate = false;
    for (let i = 0; i < rows.length; i++) {
        const v = rows[i][col];
        if (v === null || v === undefined || v === '') continue;
        if (typeof v === 'number') { sawNumber = true; continue; }
        const s = String(v);
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) { sawDate = true; continue; }
        if (!Number.isNaN(Number(s.replace(/[$,]/g, ''))) && s.trim() !== '') { sawNumber = true; continue; }
        return 'TEXT'; // any non-numeric, non-date value → text
    }
    if (sawDate && !sawNumber) return 'DATE';
    if (sawNumber) return 'NUMBER';
    return 'TEXT';
}

/** Quote an identifier for the schema text only if it isn't a plain word. */
function idn(name: string): string {
    return /^[a-zA-Z_][\w]*$/.test(name) ? name : `"${name}"`;
}

/**
 * Serialize tables (+ optional FK edges) into a schema block for the SQL prompt.
 * Example:
 *   Table schools(CDSCode TEXT, School TEXT, Virtual TEXT)
 *   Table satscores(cds TEXT, AvgScrMath NUMBER, NumTstTakr NUMBER)
 *   Foreign keys: satscores.cds = schools.CDSCode
 */
export function serializeSchema(tables: SchemaTable[], edges?: SchemaEdge[]): string {
    const lines: string[] = [];
    for (const t of tables) {
        const cols = t.rows.length ? Object.keys(t.rows[0]) : [];
        const defs = cols.map(c => `${idn(c)} ${inferType(t.rows, c)}`).join(', ');
        lines.push(`Table ${idn(t.name)}(${defs})`);
    }
    if (edges && edges.length) {
        lines.push('Foreign keys:');
        for (const e of edges) {
            lines.push(`  ${idn(e.leftTable)}.${idn(e.leftColumn)} = ${idn(e.rightTable)}.${idn(e.rightColumn)}`);
        }
    }
    return lines.join('\n');
}

/** DuckDB physical type from a semantic field's detected physical type. */
function duckType(f: SemanticField): string {
    switch (f.physicalType) {
        case 'number': return f.semanticType === 'count' || f.semanticType === 'identifier' ? 'BIGINT' : 'DOUBLE';
        case 'date': return f.hasTimeComponent ? 'TIMESTAMP' : 'DATE';
        case 'boolean': return 'BOOLEAN';
        default: return 'VARCHAR';
    }
}

/** True when SUM(field) is meaningless — a per-unit price, rate, ratio, or %. */
function isNonAdditiveMetric(f: SemanticField): boolean {
    if (f.semanticType === 'ratio' || f.semanticType === 'percentage') return true;
    return /(unit[_ ]?price|per[_ ]|_rate\b|hourly|price_per|_each|average|avg_)/i.test(f.name);
}

/**
 * Rich, METADATA-ONLY schema for the direct-SQL engine, derived from the
 * semantic model rather than raw rows. Beyond names + types it annotates each
 * column with the analytical facts an LLM needs to write CORRECT SQL:
 *   - role (measure vs dimension) and default aggregation,
 *   - which currency columns are additive (safe to SUM) vs per-unit (never SUM),
 *   - which columns are row identifiers (never GROUP BY / SUM them),
 *   - date columns + the dataset's date range for time filters,
 *   - dimension cardinality (so it prefers low-cardinality columns to group by).
 *
 * No raw row values are ever emitted — only structural metadata — so the
 * privacy guarantee is identical to the plan engine's.
 */
export function serializeSemanticModelSchema(model: SemanticModel, tableName = 'data'): string {
    const lines: string[] = [];
    const colDefs = model.fields.map(f => `${idn(f.name)} ${duckType(f)}`).join(', ');
    lines.push(`Table ${idn(tableName)}(${colDefs})`);
    lines.push('');
    lines.push('Column notes:');

    for (const f of model.fields) {
        const notes: string[] = [];
        if (f.role === 'metric') {
            notes.push('measure');
            if (f.semanticType === 'currency') notes.push('money');
            if (isNonAdditiveMetric(f)) {
                notes.push('per-unit/rate — do NOT SUM; use AVG');
            } else if (f.defaultAgg && f.defaultAgg !== 'none') {
                notes.push(`additive — aggregate with ${f.defaultAgg.toUpperCase()}`);
            }
            if (f.range) notes.push(`range ${f.range.min}..${f.range.max}`);
        } else {
            notes.push('dimension');
            const rowIdentifier = f.semanticType === 'identifier' && f.distinctCount >= model.rowCount * 0.9;
            if (rowIdentifier) {
                notes.push('row identifier — unique per row; never GROUP BY or aggregate this');
            } else if (f.semanticType === 'identifier') {
                notes.push('identifier');
            }
            if (f.physicalType === 'date') {
                notes.push('date');
                if (model.timeContext?.primaryDateColumn === f.name && model.timeContext) {
                    notes.push(`spans ${model.timeContext.minDate}..${model.timeContext.maxDate}`);
                }
            } else if (!rowIdentifier) {
                notes.push(`${f.distinctCount} distinct value(s)`);
            }
        }
        if (f.synonyms?.length) notes.push(`aka ${f.synonyms.slice(0, 4).join(', ')}`);
        lines.push(`  ${idn(f.name)}: ${notes.join('; ')}`);
    }

    if (model.compositeMetrics?.length) {
        lines.push('');
        lines.push('Governed metrics (prefer these formulas when the question asks for them):');
        for (const m of model.compositeMetrics) {
            lines.push(`  ${m.label}: ${m.formula}`);
        }
    }

    if (model.joinGraph?.edges?.length) {
        lines.push('');
        lines.push('Foreign keys:');
        for (const e of model.joinGraph.edges) {
            lines.push(`  ${idn(e.left)}.${idn(e.leftCol)} = ${idn(e.right)}.${idn(e.rightCol)}`);
        }
    }

    return lines.join('\n');
}
