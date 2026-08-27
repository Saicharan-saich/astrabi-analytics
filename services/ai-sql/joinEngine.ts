/**
 * Join Engine — works out WHICH tables a question needs and HOW to connect them.
 * ─────────────────────────────────────────────────────────────────────
 * Multi-table datasets are currently flattened into one wide table at import
 * time (analysisEngine.autoJoinDatasets). That is simple, but it joins
 * everything up front whether a question needs it or not, and a one-to-many
 * join silently duplicates fact rows — so a later SUM() double-counts.
 *
 * This module keeps the tables separate and answers three questions per query:
 *
 *   1. Which table holds each column the question mentions?   findTablesForColumn
 *   2. Which tables do we therefore need?                     resolveRequiredTables
 *   3. What is the shortest way to connect them, and does     planJoins
 *      any step duplicate rows?
 *
 * The result compiles to a FROM/JOIN clause (compileJoinClause) and carries an
 * explicit fan-out warning, so an aggregate over a duplicating join can be
 * blocked or flagged rather than quietly returning an inflated number.
 *
 * Pure and deterministic — no LLM, no database. The LLM still writes the SQL
 * for the direct-SQL path; this exists to tell it which tables are in play, and
 * to check the join it chose.
 */

import { discoverRelationships, detectCandidateKeys } from './relationshipDiscovery';

export interface JoinColumn {
    name: string;
    /** Primary key (or otherwise unique) — the key fact for fan-out detection. */
    isPK?: boolean;
}

export interface JoinTable {
    name: string;
    rowCount: number;
    columns: JoinColumn[];
}

/** A declared relationship between two tables. Treated as undirected. */
export interface JoinLink {
    leftTable: string;
    leftColumn: string;
    rightTable: string;
    rightColumn: string;
    /** 'fk' is trusted; 'name_match' is inferred and weaker. */
    type?: 'fk' | 'name_match';
    /** Directional cardinality from left table to right table. */
    cardinality?: 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many' | 'unknown';
    /** Evidence strength for inferred relationships. Declared FKs use 1. */
    confidence?: number;
}

export interface JoinStep {
    /** The table being brought in. */
    table: string;
    /** The already-included table it attaches to. */
    toTable: string;
    fromColumn: string;   // column on `toTable`
    toColumn: string;     // column on `table`
    /** True when this step can multiply rows, making later SUMs double-count. */
    fansOut: boolean;
    reason?: string;
}

export interface JoinPlan {
    /** The FROM table — the largest required table, treated as the fact table. */
    baseTable: string;
    /** Ordered so each step attaches to something already joined. */
    steps: JoinStep[];
    tablesUsed: string[];
    /** Tables that are required but unreachable through any declared link. */
    unreachable: string[];
    /** Steps that can duplicate base rows. Non-empty means aggregates are unsafe. */
    fanOutWarnings: string[];
}

const norm = (s: string) => s.trim().toLowerCase();

/** Every table containing a column of this name (case-insensitive). */
export function findTablesForColumn(column: string, tables: JoinTable[]): string[] {
    const c = norm(column);
    return tables.filter(t => t.columns.some(col => norm(col.name) === c)).map(t => t.name);
}

export interface RequiredTablesResult {
    /** Tables we are confident are needed. */
    tables: string[];
    /** column → candidate tables, where the column exists in more than one. */
    ambiguous: Record<string, string[]>;
    /** Columns found in no table at all. */
    missing: string[];
}

/**
 * Map a set of column names onto the tables that hold them.
 *
 * A column present in several tables (`id`, `name`, `created_at`) is reported
 * as ambiguous rather than guessed at — picking silently is how a join engine
 * produces a confident wrong answer. When exactly one candidate is already
 * required by an unambiguous column, that resolves it.
 */
export function resolveRequiredTables(columns: string[], tables: JoinTable[]): RequiredTablesResult {
    const required = new Set<string>();
    const ambiguous: Record<string, string[]> = {};
    const missing: string[] = [];

    for (const col of columns) {
        const hits = findTablesForColumn(col, tables);
        if (hits.length === 0) missing.push(col);
        else if (hits.length === 1) required.add(hits[0]);
        else ambiguous[col] = hits;
    }

    // An ambiguous column is settled if exactly one of its candidates is already
    // required for another, unambiguous reason.
    for (const [col, hits] of Object.entries(ambiguous)) {
        const already = hits.filter(h => required.has(h));
        if (already.length === 1) delete ambiguous[col];
    }

    return { tables: [...required], ambiguous, missing };
}

/** Undirected adjacency: table → [{ neighbour, link }]. */
function buildAdjacency(links: JoinLink[]): Map<string, { to: string; link: JoinLink }[]> {
    const adj = new Map<string, { to: string; link: JoinLink }[]>();
    const add = (from: string, to: string, link: JoinLink) => {
        const list = adj.get(from) || [];
        list.push({ to, link });
        adj.set(from, list);
    };
    for (const l of links) {
        add(l.leftTable, l.rightTable, l);
        add(l.rightTable, l.leftTable, l);
    }
    return adj;
}

/** Shortest path (fewest hops) between two tables, or null. */
function shortestPath(
    from: string,
    to: string,
    adj: Map<string, { to: string; link: JoinLink }[]>,
): { table: string; link: JoinLink }[] | null {
    if (from === to) return [];
    const seen = new Set([from]);
    const queue: { table: string; path: { table: string; link: JoinLink }[] }[] = [{ table: from, path: [] }];

    while (queue.length) {
        const { table, path } = queue.shift()!;
        for (const { to: next, link } of adj.get(table) || []) {
            if (seen.has(next)) continue;
            const nextPath = [...path, { table: next, link }];
            if (next === to) return nextPath;
            seen.add(next);
            queue.push({ table: next, path: nextPath });
        }
    }
    return null;
}

/**
 * Does joining `incoming` to `anchor` risk duplicating anchor rows?
 *
 * Safe (many-to-one) when the incoming side's join column is unique — a PK, or
 * a column whose distinct count equals the row count. If it is not unique, one
 * anchor row can match several incoming rows, inflating every later SUM.
 */
function detectFanOut(incoming: JoinTable | undefined, incomingColumn: string): { fansOut: boolean; reason?: string } {
    if (!incoming) return { fansOut: true, reason: 'unknown table — cannot verify uniqueness' };
    const col = incoming.columns.find(c => norm(c.name) === norm(incomingColumn));
    if (!col) return { fansOut: true, reason: `"${incomingColumn}" not found on ${incoming.name}` };
    if (col.isPK) return { fansOut: false };
    return {
        fansOut: true,
        reason: `${incoming.name}.${incomingColumn} is not unique, so one row can match many — totals would be inflated`,
    };
}

/**
 * Build a join plan connecting every required table.
 *
 * The base is the largest required table (the fact table by convention — the
 * one you aggregate). Every other required table is attached by its shortest
 * declared path, pulling in bridge tables where needed.
 */
export function planJoins(
    requiredTables: string[],
    tables: JoinTable[],
    links: JoinLink[],
    opts?: { baseTable?: string },
): JoinPlan {
    const byName = new Map(tables.map(t => [t.name, t]));
    const required = [...new Set(requiredTables)].filter(t => byName.has(t));

    if (required.length === 0) {
        return { baseTable: '', steps: [], tablesUsed: [], unreachable: [...new Set(requiredTables)], fanOutWarnings: [] };
    }

    // Fact table = most rows, unless the caller names a base.
    const baseTable = opts?.baseTable && byName.has(opts.baseTable)
        ? opts.baseTable
        : required.slice().sort((a, b) => (byName.get(b)!.rowCount || 0) - (byName.get(a)!.rowCount || 0))[0];

    const adj = buildAdjacency(links);
    const included = new Set([baseTable]);
    const steps: JoinStep[] = [];
    const unreachable: string[] = [];

    // Attach nearest tables first so bridges are usually already in place.
    const targets = required
        .filter(t => t !== baseTable)
        .map(t => ({ table: t, path: shortestPath(baseTable, t, adj) }))
        .sort((a, b) => (a.path?.length ?? Infinity) - (b.path?.length ?? Infinity));

    for (const { table, path } of targets) {
        if (included.has(table)) continue;
        if (!path) { unreachable.push(table); continue; }

        for (const hop of path) {
            if (included.has(hop.table)) continue;
            const l = hop.link;
            // Orient the link so `toTable` is the side already joined.
            const incomingIsRight = l.rightTable === hop.table;
            const anchorTable = incomingIsRight ? l.leftTable : l.rightTable;
            const anchorColumn = incomingIsRight ? l.leftColumn : l.rightColumn;
            const incomingColumn = incomingIsRight ? l.rightColumn : l.leftColumn;

            const { fansOut, reason } = detectFanOut(byName.get(hop.table), incomingColumn);
            steps.push({
                table: hop.table,
                toTable: anchorTable,
                fromColumn: anchorColumn,
                toColumn: incomingColumn,
                fansOut,
                reason,
            });
            included.add(hop.table);
        }
    }

    return {
        baseTable,
        steps,
        tablesUsed: [...included],
        unreachable,
        fanOutWarnings: steps.filter(s => s.fansOut).map(s => `${s.table}: ${s.reason}`),
    };
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Render a plan as a SQL FROM/JOIN clause. LEFT JOIN keeps unmatched base rows. */
export function compileJoinClause(plan: JoinPlan): string {
    if (!plan.baseTable) return '';
    const lines = [`FROM ${q(plan.baseTable)}`];
    for (const s of plan.steps) {
        lines.push(`LEFT JOIN ${q(s.table)} ON ${q(s.toTable)}.${q(s.fromColumn)} = ${q(s.table)}.${q(s.toColumn)}`);
    }
    return lines.join('\n');
}

/**
 * Adapt a connector's SourceSchema (types.ts) into the engine's input.
 *
 * The connector already records every table's columns, which are primary keys,
 * and the join edges it detected — everything the planner needs, so no separate
 * discovery step is required.
 */
export function fromSourceSchema(source: {
    tables: { name: string; rows: number; columns: { name: string; isPK: boolean }[] }[];
    joinEdges: { leftTable: string; rightTable: string; leftColumn: string; rightColumn: string; type?: string }[];
}): { tables: JoinTable[]; links: JoinLink[] } {
    return {
        tables: (source.tables || []).map(t => ({
            name: t.name,
            rowCount: t.rows || 0,
            columns: (t.columns || []).map(c => ({ name: c.name, isPK: !!c.isPK })),
        })),
        links: (source.joinEdges || []).map(e => {
            const left = source.tables.find(table => table.name === e.leftTable)
                ?.columns.find(column => norm(column.name) === norm(e.leftColumn));
            const right = source.tables.find(table => table.name === e.rightTable)
                ?.columns.find(column => norm(column.name) === norm(e.rightColumn));
            const cardinality: NonNullable<JoinLink['cardinality']> = left?.isPK && right?.isPK
                ? 'one-to-one'
                : left?.isPK
                    ? 'one-to-many'
                    : right?.isPK
                        ? 'many-to-one'
                        : 'many-to-many';
            return {
                leftTable: e.leftTable,
                leftColumn: e.leftColumn,
                rightTable: e.rightTable,
                rightColumn: e.rightColumn,
                type: e.type === 'fk' ? 'fk' : 'name_match',
                cardinality,
                confidence: e.type === 'fk' ? 1 : 0.7,
            };
        }),
    };
}

/**
 * Describe a multi-table schema for the LLM: every table with its columns, which
 * are primary keys, and the relationships between them.
 *
 * Given this, a capable model does its own schema linking and picks its own join
 * path — it does not need us to detect columns for it. planJoins() then exists
 * to CHECK the model's choice (and to serve the deterministic path), which is
 * the more valuable job: catching a fan-out the model did not notice.
 *
 * Metadata only — no row values.
 */
export function describeSchemaForLLM(tables: JoinTable[], links: JoinLink[]): string {
    const lines: string[] = [];
    for (const t of tables) {
        const cols = t.columns
            .map(c => (c.isPK ? `${c.name} [PK]` : c.name))
            .join(', ');
        lines.push(`Table ${t.name} (${t.rowCount.toLocaleString()} rows): ${cols}`);
    }
    if (links.length) {
        lines.push('');
        lines.push('Relationships — join on these:');
        for (const l of links) {
            const note = l.type === 'name_match' ? '  (inferred from column names — verify it makes sense)' : '';
            const shape = l.cardinality ? ` [${l.cardinality}${typeof l.confidence === 'number' ? `; confidence ${l.confidence.toFixed(2)}` : ''}]` : '';
            lines.push(`  ${l.leftTable}.${l.leftColumn} = ${l.rightTable}.${l.rightColumn}${shape}${note}`);
        }
    }
    lines.push('');
    lines.push('Join only the tables the question needs. Aggregating after a one-to-many join double-counts, so aggregate at the right grain (a subquery first if necessary).');
    return lines.join('\n');
}

export interface FlattenSelection {
    baseTable: string;
    /** Links safe to fold into one wide table — every step is many-to-one. */
    safe: JoinLink[];
    /** Tables deliberately left out, with the reason. */
    excluded: { table: string; reason: string }[];
}

/**
 * Decide which tables may be folded into a single flat table.
 *
 * Flattening is only lossless when every step is many-to-one. A one-to-many
 * step multiplies the fact rows, so either totals inflate (a true join) or rows
 * are silently discarded (a first-match join) — both wrong, one quietly.
 *
 * Example: OrderItems joined to ProductSuppliers, where a product has several
 * suppliers, inflates revenue ~2.2x. Such a table is excluded here and stays
 * available as a separate table, which AI SQL can join at the right grain.
 * Anything only reachable *through* an excluded table is excluded too.
 */
export function selectFlattenableLinks(
    tables: JoinTable[],
    links: JoinLink[],
    opts?: { baseTable?: string },
): FlattenSelection {
    const byName = new Map(tables.map(t => [t.name, t]));
    if (tables.length === 0) return { baseTable: '', safe: [], excluded: [] };

    const baseTable = opts?.baseTable && byName.has(opts.baseTable)
        ? opts.baseTable
        : tables.slice().sort((a, b) => (b.rowCount || 0) - (a.rowCount || 0))[0].name;

    const adj = buildAdjacency(links);
    const included = new Set([baseTable]);
    const safe: JoinLink[] = [];
    const excluded: { table: string; reason: string }[] = [];

    // Grow outward from the base, taking only many-to-one steps.
    let progressed = true;
    while (progressed) {
        progressed = false;
        for (const anchor of [...included]) {
            for (const { to, link } of adj.get(anchor) || []) {
                if (included.has(to)) continue;
                const incomingColumn = link.rightTable === to ? link.rightColumn : link.leftColumn;
                const { fansOut, reason } = detectFanOut(byName.get(to), incomingColumn);
                if (fansOut) continue;   // may still be reachable safely elsewhere
                included.add(to);
                safe.push(link);
                progressed = true;
            }
        }
    }

    for (const t of tables) {
        if (included.has(t.name)) continue;
        const reachable = (adj.get(t.name) || []).some(n => included.has(n.to));
        excluded.push({
            table: t.name,
            reason: reachable
                ? `each row of ${baseTable} matches several rows here, so folding it in would duplicate rows and inflate totals`
                : `only reachable through a table that was already excluded`,
        });
    }

    return { baseTable, safe, excluded };
}

/**
 * Build the multi-table context for a dataset, ready to hand to the model.
 *
 * Relationships come from the connector's declared foreign keys when we have
 * them; otherwise they are inferred from the values (relationshipDiscovery).
 * Returns null for a single-table dataset, so callers can skip this entirely.
 */
export function discoverJoinContext(
    relatedTables?: { name: string; rows: Record<string, any>[] }[],
    sourceSchema?: {
        tables?: { name: string; rows: number; columns: { name: string; isPK: boolean }[] }[];
        joinEdges?: { leftTable: string; rightTable: string; leftColumn: string; rightColumn: string; type?: string }[];
    },
): { description: string; tableNames: string[]; tables: JoinTable[]; links: JoinLink[] } | null {
    if (!relatedTables || relatedTables.length < 2) return null;

    let tables: JoinTable[];
    let links: JoinLink[];

    if (sourceSchema?.tables?.length && sourceSchema.joinEdges?.length) {
        // Declared schema — trust it.
        ({ tables, links } = fromSourceSchema({
            tables: sourceSchema.tables,
            joinEdges: sourceSchema.joinEdges,
        }));
    } else {
        // No declared relationships: infer keys and links from the data itself.
        const discovery = discoverRelationships(relatedTables);
        tables = relatedTables.map(t => {
            const keys = new Map(
                detectCandidateKeys({ name: t.name, rows: t.rows }).map(k => [k.column, k]),
            );
            return {
                name: t.name,
                rowCount: t.rows.length,
                columns: Object.keys(t.rows[0] || {}).map(c => ({ name: c, isPK: !!keys.get(c)?.isKey })),
            };
        });
        links = discovery.relationships.map(r => ({
            leftTable: r.fromTable, leftColumn: r.fromColumn,
            rightTable: r.toTable, rightColumn: r.toColumn,
            type: 'fk' as const,
            cardinality: r.cardinality,
            confidence: r.confidence,
        }));
    }

    if (!tables.length) return null;
    return {
        description: describeSchemaForLLM(tables, links),
        tableNames: tables.map(t => t.name),
        tables,
        links,
    };
}

/**
 * End-to-end: from the columns a question needs to a ready join clause.
 * Returns the plan too, so callers can surface ambiguity and fan-out.
 */
export function planJoinsForColumns(
    columns: string[],
    tables: JoinTable[],
    links: JoinLink[],
): { plan: JoinPlan; sql: string; resolution: RequiredTablesResult } {
    const resolution = resolveRequiredTables(columns, tables);
    const plan = planJoins(resolution.tables, tables, links);
    return { plan, sql: compileJoinClause(plan), resolution };
}
