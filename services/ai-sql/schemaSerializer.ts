/**
 * Schema serializer for the direct SQL-semantics engine.
 * ─────────────────────────────────────────────────────────────────────
 * Produces a compact, METADATA-ONLY description of a database (table + column
 * names, inferred types, and foreign keys) to hand to the LLM. No row values are
 * ever included — the privacy guarantee is identical to the plan engine's.
 */

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
