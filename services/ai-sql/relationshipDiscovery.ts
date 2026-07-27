/**
 * Relationship Discovery — infer keys and joins from the DATA, not the names.
 * ─────────────────────────────────────────────────────────────────────
 * A database connector hands us real foreign keys. An uploaded workbook does
 * not: several sheets arrive with no declared relationships at all, so they have
 * to be inferred. Guessing from column names ("both have `id`, join them") is
 * how a BI tool produces a confidently wrong number.
 *
 * This module infers relationships from evidence instead:
 *
 *   1. A column can only be the ONE side of a join if it is an actual key —
 *      unique and non-null across every row.
 *   2. A column is the MANY side only if its values are genuinely contained in
 *      that key (an inclusion dependency), measured, not assumed.
 *   3. Types must be compatible, and the key must carry enough distinct values
 *      to be an identifier rather than a flag.
 *
 * Anything that fails is reported with its reason rather than silently dropped
 * or silently accepted. Name similarity is used only to break ties between
 * candidates that already passed on evidence — never as evidence itself.
 *
 * Honest limit: inference over a sample can never be *proven* correct, so every
 * relationship carries a confidence and its supporting numbers. Callers should
 * surface low-confidence joins for confirmation rather than applying them
 * silently.
 */

export interface DiscoveryTable {
    name: string;
    rows: Record<string, any>[];
}

export interface CandidateKey {
    table: string;
    column: string;
    distinctCount: number;
    rowCount: number;
    nullCount: number;
    /** Unique and non-null across all rows — the only thing safe to join TO. */
    isKey: boolean;
    reason?: string;
}

export interface DiscoveredRelationship {
    /** The many side — holds the reference. */
    fromTable: string;
    fromColumn: string;
    /** The one side — must be a key. */
    toTable: string;
    toColumn: string;
    /** Fraction of non-null from-values present in the key. 1 = total containment. */
    coverage: number;
    /** Distinct from-values matched. */
    matchedDistinct: number;
    distinctFrom: number;
    cardinality: 'many-to-one' | 'one-to-one';
    confidence: number;
    evidence: string[];
}

export interface RejectedRelationship {
    fromTable: string; fromColumn: string;
    toTable: string; toColumn: string;
    reason: string;
}

export interface DiscoveryResult {
    keys: CandidateKey[];
    relationships: DiscoveredRelationship[];
    /** Pairs that looked plausible but failed a check — useful for explaining. */
    rejected: RejectedRelationship[];
}

/** Values below this are flags/categories, not identifiers. */
const MIN_KEY_DISTINCT = 3;
/** Share of non-null child values that must exist in the parent key. */
const MIN_COVERAGE = 0.85;
/** Cap rows scanned per column so discovery stays fast on large files. */
const SAMPLE_LIMIT = 20_000;

const isBlank = (v: any) => v === null || v === undefined || v === '';

/** Compare by normalised string so 1 and "1" match across sheets. */
const key = (v: any) => (typeof v === 'string' ? v.trim() : String(v));

function columnValues(rows: Record<string, any>[], col: string): { values: string[]; nullCount: number } {
    const values: string[] = [];
    let nullCount = 0;
    const limit = Math.min(rows.length, SAMPLE_LIMIT);
    for (let i = 0; i < limit; i++) {
        const v = rows[i]?.[col];
        if (isBlank(v)) { nullCount++; continue; }
        values.push(key(v));
    }
    return { values, nullCount };
}

/** Loose type agreement — numeric-looking vs text. Mixed types can't be a join. */
function typeOf(values: string[]): 'number' | 'text' | 'mixed' {
    let num = 0, txt = 0;
    for (const v of values.slice(0, 200)) {
        if (v !== '' && !Number.isNaN(Number(v))) num++; else txt++;
    }
    if (num && txt) return num / (num + txt) > 0.95 ? 'number' : txt / (num + txt) > 0.95 ? 'text' : 'mixed';
    return num ? 'number' : 'text';
}

/**
 * Find every column that is a genuine key: unique, non-null, and carrying
 * enough distinct values to identify a row rather than label it.
 */
export function detectCandidateKeys(table: DiscoveryTable): CandidateKey[] {
    const rows = table.rows || [];
    if (rows.length === 0) return [];
    const cols = Object.keys(rows[0] || {});
    const out: CandidateKey[] = [];

    for (const col of cols) {
        const { values, nullCount } = columnValues(rows, col);
        const distinct = new Set(values);
        const scanned = Math.min(rows.length, SAMPLE_LIMIT);

        let isKey = true;
        let reason: string | undefined;
        if (nullCount > 0) { isKey = false; reason = 'contains blanks, so it cannot identify every row'; }
        else if (distinct.size !== values.length) { isKey = false; reason = 'values repeat, so it is not unique'; }
        else if (distinct.size < MIN_KEY_DISTINCT) { isKey = false; reason = 'too few distinct values to be an identifier'; }

        out.push({
            table: table.name, column: col,
            distinctCount: distinct.size, rowCount: scanned, nullCount,
            isKey, reason,
        });
    }
    return out;
}

/**
 * True for a dense run of integers (1,2,3,…) — a surrogate key.
 *
 * Containment between two of these proves nothing: every table numbered from 1
 * contains every shorter table numbered from 1, so `customers.customer_id`
 * (1-3) sits perfectly inside `visits.visit_id` (1-4) by pure coincidence.
 * When both sides look like this, evidence alone cannot decide and the column
 * names have to agree as well.
 */
function isDenseIntegerSequence(values: Iterable<string>): boolean {
    let min = Infinity, max = -Infinity, count = 0;
    const seen = new Set<number>();
    for (const v of values) {
        const n = Number(v);
        if (!Number.isInteger(n)) return false;
        if (n < min) min = n;
        if (n > max) max = n;
        seen.add(n);
        count++;
        if (count > SAMPLE_LIMIT) break;
    }
    if (seen.size < 2) return false;
    return (max - min + 1) <= seen.size * 1.5;
}

/** Name agreement, used ONLY to rank candidates that already passed on evidence. */
function nameAffinity(fromTable: string, fromCol: string, toTable: string, toCol: string): number {
    const f = fromCol.toLowerCase().replace(/[^a-z0-9]/g, '');
    const t = toCol.toLowerCase().replace(/[^a-z0-9]/g, '');
    const tbl = toTable.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
    if (f === t) return 0.10;
    if (f === `${tbl}id` || f === `${tbl}key` || f === `${tbl}code`) return 0.10;
    if (f.includes(tbl)) return 0.05;
    return 0;
}

/**
 * Discover relationships across a set of tables.
 *
 * For every (child column → parent key) pair it measures how completely the
 * child's values are contained in the parent's key. Only pairs that clear the
 * coverage threshold become relationships; everything else is returned in
 * `rejected` with the reason, so a user can see why two sheets were NOT joined.
 */
export function discoverRelationships(tables: DiscoveryTable[]): DiscoveryResult {
    const usable = (tables || []).filter(t => (t.rows || []).length > 0);
    const keys: CandidateKey[] = [];
    for (const t of usable) keys.push(...detectCandidateKeys(t));

    const keyIndex = new Map<string, { table: string; column: string; values: Set<string>; type: string; dense: boolean }>();
    for (const k of keys) {
        if (!k.isKey) continue;
        const t = usable.find(x => x.name === k.table)!;
        const { values } = columnValues(t.rows, k.column);
        const set = new Set(values);
        keyIndex.set(`${k.table}.${k.column}`, {
            table: k.table, column: k.column,
            values: set, type: typeOf(values),
            dense: isDenseIntegerSequence(set),
        });
    }

    const relationships: DiscoveredRelationship[] = [];
    const rejected: RejectedRelationship[] = [];

    for (const child of usable) {
        const childCols = Object.keys(child.rows[0] || {});
        for (const childCol of childCols) {
            const { values: childValues } = columnValues(child.rows, childCol);
            if (childValues.length === 0) continue;
            const childDistinct = new Set(childValues);
            const childType = typeOf(childValues);

            for (const parent of keyIndex.values()) {
                if (parent.table === child.name) continue;   // never self-join a sheet

                // Type must agree — matching a number column to text is spurious.
                if (childType === 'mixed' || parent.type === 'mixed' || childType !== parent.type) {
                    continue;   // too weak to even report
                }

                let matched = 0;
                for (const v of childDistinct) if (parent.values.has(v)) matched++;
                const coverage = matched / childDistinct.size;

                if (coverage < MIN_COVERAGE) {
                    // Only report near-misses; unrelated columns would be noise.
                    if (coverage >= 0.4) {
                        rejected.push({
                            fromTable: child.name, fromColumn: childCol,
                            toTable: parent.table, toColumn: parent.column,
                            reason: `only ${Math.round(coverage * 100)}% of values exist in ${parent.table}.${parent.column} — not a reliable relationship`,
                        });
                    }
                    continue;
                }

                if (childDistinct.size < MIN_KEY_DISTINCT) {
                    rejected.push({
                        fromTable: child.name, fromColumn: childCol,
                        toTable: parent.table, toColumn: parent.column,
                        reason: 'too few distinct values — looks like a flag, not a reference',
                    });
                    continue;
                }

                // Two surrogate key sequences overlap by construction, so
                // containment is not evidence. Require the names to agree too.
                const affinity = nameAffinity(child.name, childCol, parent.table, parent.column);
                if (affinity === 0 && parent.dense && isDenseIntegerSequence(childDistinct)) {
                    rejected.push({
                        fromTable: child.name, fromColumn: childCol,
                        toTable: parent.table, toColumn: parent.column,
                        reason: `both are numbered sequences, so the overlap is coincidental — "${childCol}" and "${parent.column}" name different things`,
                    });
                    continue;
                }

                const oneToOne = childDistinct.size === childValues.length;
                const evidence = [
                    `${Math.round(coverage * 100)}% of ${child.name}.${childCol} values found in ${parent.table}.${parent.column}`,
                    `${parent.table}.${parent.column} is unique and non-null (a real key)`,
                    oneToOne ? 'child values are also unique — one-to-one' : 'child values repeat — many-to-one',
                ];

                relationships.push({
                    fromTable: child.name, fromColumn: childCol,
                    toTable: parent.table, toColumn: parent.column,
                    coverage,
                    matchedDistinct: matched,
                    distinctFrom: childDistinct.size,
                    cardinality: oneToOne ? 'one-to-one' : 'many-to-one',
                    // Evidence first; the name only nudges between equals.
                    confidence: Math.min(1, coverage * 0.9 + affinity),
                    evidence,
                });
            }
        }
    }

    // Keep the single best parent per child column — a column references one thing.
    const best = new Map<string, DiscoveredRelationship>();
    for (const r of relationships) {
        const k = `${r.fromTable}.${r.fromColumn}`;
        const cur = best.get(k);
        if (!cur || r.confidence > cur.confidence) {
            if (cur) {
                rejected.push({
                    fromTable: cur.fromTable, fromColumn: cur.fromColumn,
                    toTable: cur.toTable, toColumn: cur.toColumn,
                    reason: `superseded by a stronger match on ${r.toTable}.${r.toColumn}`,
                });
            }
            best.set(k, r);
        } else {
            rejected.push({
                fromTable: r.fromTable, fromColumn: r.fromColumn,
                toTable: r.toTable, toColumn: r.toColumn,
                reason: `weaker than the match on ${cur.toTable}.${cur.toColumn}`,
            });
        }
    }

    return {
        keys,
        relationships: [...best.values()].sort((a, b) => b.confidence - a.confidence),
        rejected,
    };
}
