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

/** True when a field holds a date/time (by physical or semantic type). */
function isDateField(f: SemanticField): boolean {
    return f.physicalType === 'date' || f.semanticType === 'date';
}

/**
 * The ACTUAL DuckDB column type in this app. Dates are loaded from CSV as text
 * (VARCHAR), NOT as DATE — so we report VARCHAR for them, otherwise the model
 * writes DATE_TRUNC(order_date) and DuckDB rejects it ("date_trunc(…, VARCHAR)").
 */
function duckType(f: SemanticField): string {
    if (isDateField(f)) return 'VARCHAR';
    switch (f.physicalType) {
        case 'number': return f.semanticType === 'count' || f.semanticType === 'identifier' ? 'BIGINT' : 'DOUBLE';
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
 * True when a column's VALUES must never leave the browser — identifiers and
 * person-level PII (customer/patient/employee names, emails, phones, addresses,
 * SSNs, card numbers, etc.). Note: item/product/category "name" columns are NOT
 * sensitive — only person-related name columns are excluded.
 */
export function isSensitiveColumn(f: SemanticField): boolean {
    if (f.semanticType === 'identifier') return true;
    const n = f.name.toLowerCase();
    // Explicit PII fields — never send their values.
    if (/(e[_ ]?mail|phone|mobile|telephone|\bfax\b|address|street|postcode|postal|\bzip\b|ssn|social[_ ]?security|passport|licen[sc]e|\bdob\b|birth|credit[_ ]?card|card[_ ]?number|\biban\b|account[_ ]?number|\bpan\b)/.test(n)) return true;
    // Person-name columns (customer_name, patient_full_name…) — but NOT item_name / product_name / category_name.
    const person = /(customer|client|patient|employee|person|people|\buser\b|contact|staff|\bmember\b|guest|buyer|seller|owner|holder|attendee|applicant|resident|tenant|donor|driver|passenger|cardholder|account[_ ]?holder)/;
    if (person.test(n) && /(name|full|first|last|middle)/.test(n)) return true;
    if (/^(first|last|full|middle)[_ ]?name$/.test(n)) return true;
    // Sensitive categoricals — low-cardinality columns whose VALUES are
    // themselves sensitive (health, protected characteristics, financial /
    // legal status). These would slip past the name/PII checks above, so
    // exclude their value domains outright.
    if (/(diagnos|disease|condition|symptom|medication|\bdrug\b|treatment|\bicd\b|procedure|health|medical|clinical|mental|disabilit|pregnan|\bhiv\b)/.test(n)) return true;
    if (/(ethnic|\brace\b|religio|\bfaith\b|\bcaste\b|nationalit|citizenship|immigration|\bgender\b|\bsex\b|sexual|orientation|marital|\bpolitic\b|union[_ ]?member|veteran)/.test(n)) return true;
    if (/(salary|\bwage\b|\bincome\b|\bpay\b|compensation|credit[_ ]?score|\bdebt\b|\bloan\b|bankrupt|net[_ ]?worth|criminal|convict|offen[sc]e|arrest)/.test(n)) return true;
    return false;
}

/**
 * Collect the distinct value DOMAINS of low-cardinality, non-sensitive
 * categorical dimensions (categories, geography, status, payment method, item /
 * product names, booleans, ordinals). These are the domains an LLM needs to
 * write correct WHERE/HAVING literals — sending them stops it guessing values it
 * can't see (e.g. 'Coffee' when the real value is 'Cappuccino').
 *
 * Strictly bounded: identifiers and person-level PII are NEVER included (see
 * isSensitiveColumn), transaction rows are never sent, and each column is capped
 * at `maxSample` values.
 */
export function collectSafeDomains(
    rows: Record<string, any>[],
    model: SemanticModel,
    opts?: { maxCardinality?: number; maxSample?: number },
): Map<string, { values: string[]; total: number }> {
    const maxSample = opts?.maxSample ?? 50;
    const out = new Map<string, { values: string[]; total: number }>();
    if (!rows || rows.length === 0) return out;

    const ALLOWED: SemanticField['semanticType'][] = ['category', 'geography', 'boolean', 'ordinal'];
    const fields = model.fields.filter(f =>
        f.role === 'dimension'
        && f.physicalType !== 'date'
        && f.semanticType !== 'date'
        && ALLOWED.includes(f.semanticType)
        && !isSensitiveColumn(f)
        // Skip near-unique columns — those are effectively identifiers / free
        // text, not categories, and a sample of them helps nobody.
        && !(model.rowCount > 0 && f.distinctCount >= model.rowCount * 0.9));

    for (const f of fields) {
        const seen = new Set<string>();
        const values: string[] = [];
        for (const row of rows) {
            const raw = row[f.name];
            if (raw === null || raw === undefined || raw === '') continue;
            const val = String(raw).trim();
            if (!val || seen.has(val)) continue;
            seen.add(val);
            if (values.length < maxSample) values.push(val);
        }
        // `total` is the true distinct count; when it exceeds what we sent, the
        // serializer marks the list as a partial SAMPLE so the model knows not to
        // assume the list is exhaustive. High-cardinality category columns (e.g.
        // 120 menu items) now send a capped sample instead of nothing at all —
        // previously they were dropped entirely, so the model had to guess
        // literals for exactly the columns questions ask about most.
        if (values.length > 0) out.set(f.name, { values, total: seen.size });
    }
    return out;
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
export function serializeSemanticModelSchema(
    model: SemanticModel,
    tableName = 'data',
    domains?: Map<string, { values: string[]; total: number }>,
): string {
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
            if (isDateField(f)) {
                notes.push("date stored as TEXT (e.g. '2025-06-30') — you MUST wrap it in CAST(col AS DATE) before DATE_TRUNC / EXTRACT / strftime or any date comparison");
                if (model.timeContext?.primaryDateColumn === f.name && model.timeContext) {
                    notes.push(`spans ${model.timeContext.minDate}..${model.timeContext.maxDate}`);
                }
            } else if (!rowIdentifier) {
                notes.push(`${f.distinctCount} distinct value(s)`);
            }
        }
        if (f.synonyms?.length) notes.push(`aka ${f.synonyms.slice(0, 4).join(', ')}`);
        const dom = domains?.get(f.name);
        if (dom && dom.values.length) {
            const shown = dom.values.map(v => `'${v}'`).join(', ');
            if (dom.total > dom.values.length) {
                // Partial list — the model must not assume these are all the values.
                notes.push(`SAMPLE of ${dom.values.length} of ${dom.total} values: [${shown}] — this list is NOT complete; copy the exact spelling/casing shown, and if the value the user asked for is not listed use a case-insensitive LIKE '%…%' match instead of =`);
            } else {
                notes.push(`values (complete list): [${shown}] — use these EXACT values in filters`);
            }
        }
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
