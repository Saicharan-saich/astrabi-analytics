/**
 * queryPruner.ts — SourceSchema-Aware Query Pruning
 *
 * PROBLEM:
 *   When a fact table (Sales) is LEFT JOINed to a dimension table (Products),
 *   dimension-table columns get duplicated across every fact row.
 *   e.g., current_quantity=220 appears 3 times (one per sale) → SUM = 660.
 *
 * SOLUTION:
 *   If ALL queried columns (metric + dimension + secondary metrics/dims) come
 *   from a SINGLE dimension table, deduplicate the rows to unique combinations
 *   of those columns. This eliminates join fan-out before aggregation runs.
 *
 * RULES:
 *   - Only activates when sourceSchema is available (multi-table datasets)
 *   - Only deduplicates when ALL queried columns belong to ONE non-fact table
 *   - Fact table detection uses row count + column heuristics
 *   - Falls through silently when conditions aren't met (no-op)
 */

import type { SourceSchema, QueryConfig } from '../types';

// ═══════════════════════════════════════════════════════════════════
// COLUMN → TABLE MAPPING
// ═══════════════════════════════════════════════════════════════════

interface ColumnTableMap {
    /** Maps column name (lowercase) → source table name */
    columnToTable: Map<string, string>;
    /** The detected fact table name (highest row count or most FK references) */
    factTable: string | null;
    /** All table names */
    tables: string[];
}

/**
 * Build a map of column → source table from the sourceSchema.
 * When a column exists in multiple tables (e.g., product_id in both Sales and Products),
 * prefer the dimension table (non-fact table).
 */
function buildColumnTableMap(sourceSchema: SourceSchema): ColumnTableMap {
    const columnToTable = new Map<string, string>();
    const tableSizes = new Map<string, number>();

    // Collect table sizes and column mappings
    for (const table of sourceSchema.tables) {
        tableSizes.set(table.name, table.rows);
        for (const col of table.columns) {
            const colLower = col.name.toLowerCase();
            // If column already mapped, keep the mapping to the smaller table (dimension table)
            // since the larger table is typically the fact table
            if (columnToTable.has(colLower)) {
                const existingTable = columnToTable.get(colLower)!;
                const existingSize = tableSizes.get(existingTable) || 0;
                const currentSize = tableSizes.get(table.name) || 0;
                // Keep the smaller table's mapping (dimension tables are smaller)
                if (currentSize < existingSize) {
                    columnToTable.set(colLower, table.name);
                }
            } else {
                columnToTable.set(colLower, table.name);
            }
        }
    }

    // Detect fact table: highest row count among selected tables
    let factTable: string | null = null;
    let maxRows = 0;
    for (const table of sourceSchema.tables) {
        if (table.rows > maxRows) {
            maxRows = table.rows;
            factTable = table.name;
        }
    }

    return {
        columnToTable,
        factTable,
        tables: sourceSchema.tables.map(t => t.name),
    };
}

/**
 * Resolve the source table for a column name, with case-insensitive fallback.
 */
function resolveTable(columnName: string, map: ColumnTableMap): string | null {
    const lower = columnName.toLowerCase();
    if (map.columnToTable.has(lower)) return map.columnToTable.get(lower)!;

    // Try without underscores/spaces normalization
    const normalized = lower.replace(/[_\s]+/g, '');
    for (const [key, table] of map.columnToTable) {
        if (key.replace(/[_\s]+/g, '') === normalized) return table;
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN: pruneRowsForQuery
// ═══════════════════════════════════════════════════════════════════

export interface PruneResult {
    /** The rows to use (either original or deduped) */
    rows: Record<string, any>[];
    /** Whether pruning was applied */
    pruned: boolean;
    /** Human-readable log of what happened */
    log: string;
    /** The single source table name if pruned, null otherwise */
    sourceTable: string | null;
}

/**
 * Check if all queried columns come from a single dimension table.
 * If so, deduplicate the rows to eliminate join fan-out.
 *
 * @param rows - The full merged dataset rows
 * @param query - The current query configuration
 * @param sourceSchema - Multi-table schema metadata (from connector)
 * @returns PruneResult with either original or deduped rows
 */
export function pruneRowsForQuery(
    rows: Record<string, any>[],
    query: QueryConfig,
    sourceSchema: SourceSchema | undefined
): PruneResult {
    // ── Guard: No sourceSchema → no pruning possible ──
    if (!sourceSchema || !sourceSchema.tables || sourceSchema.tables.length <= 1) {
        return { rows, pruned: false, log: 'No multi-table schema — skipping pruning', sourceTable: null };
    }

    // ── Collect ALL columns referenced by this query ──
    const queriedColumns: string[] = [];

    // Primary metric
    if (query.metric) queriedColumns.push(query.metric);

    // Primary dimension (skip time grains — they come from date columns)
    const timeGrains = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
    if (query.dimension && !timeGrains.includes(query.dimension)) {
        queriedColumns.push(query.dimension);
    }

    // Secondary metrics
    if (query.secondaryMetrics) {
        queriedColumns.push(...query.secondaryMetrics);
    }

    // Secondary dimensions
    if (query.secondaryDimensions) {
        queriedColumns.push(...query.secondaryDimensions);
    }

    if (queriedColumns.length === 0) {
        return { rows, pruned: false, log: 'No columns to check — skipping pruning', sourceTable: null };
    }

    // ── Build column → table map ──
    const map = buildColumnTableMap(sourceSchema);

    // ── Check: do ALL queried columns come from ONE table? ──
    const tableSources = new Set<string>();
    const unmappedColumns: string[] = [];

    for (const col of queriedColumns) {
        const table = resolveTable(col, map);
        if (table) {
            tableSources.add(table);
        } else {
            unmappedColumns.push(col);
        }
    }

    // If any columns couldn't be mapped, or columns come from multiple tables → no pruning
    if (unmappedColumns.length > 0) {
        return {
            rows,
            pruned: false,
            log: `Cannot map columns to source tables: [${unmappedColumns.join(', ')}] — skipping pruning`,
            sourceTable: null,
        };
    }

    if (tableSources.size !== 1) {
        return {
            rows,
            pruned: false,
            log: `Columns span ${tableSources.size} tables (${[...tableSources].join(', ')}) — no pruning (cross-table query)`,
            sourceTable: null,
        };
    }

    const singleTable = [...tableSources][0];

    // ── Check: is this the fact table? If so, no pruning needed ──
    if (singleTable === map.factTable) {
        return {
            rows,
            pruned: false,
            log: `All columns from fact table "${singleTable}" — no pruning needed`,
            sourceTable: null,
        };
    }

    // ═══ ALL columns from ONE dimension table → DEDUPLICATE ═══
    // Deduplicate rows to unique combinations of the queried columns only.
    // This eliminates duplicates from the fact-table join.

    console.log(`[QueryPruner] ✅ All columns from dimension table "${singleTable}" — deduplicating rows`);
    console.log(`[QueryPruner]    Columns: [${queriedColumns.join(', ')}]`);
    console.log(`[QueryPruner]    Before: ${rows.length} rows`);

    // Resolve actual column keys from first row (case-insensitive matching)
    const resolvedKeys: string[] = [];
    if (rows.length > 0) {
        const firstRow = rows[0];
        const rowKeys = Object.keys(firstRow);
        for (const col of queriedColumns) {
            const match = rowKeys.find(k => k.toLowerCase() === col.toLowerCase())
                || rowKeys.find(k => k.toLowerCase().replace(/[_\s]+/g, '') === col.toLowerCase().replace(/[_\s]+/g, ''))
                || col;
            resolvedKeys.push(match);
        }
    } else {
        resolvedKeys.push(...queriedColumns);
    }

    // Build unique row set
    const seen = new Set<string>();
    const dedupedRows: Record<string, any>[] = [];

    for (const row of rows) {
        // Build a composite key from the queried columns only
        const keyParts = resolvedKeys.map(k => String(row[k] ?? ''));
        const compositeKey = keyParts.join('|__|');

        if (!seen.has(compositeKey)) {
            seen.add(compositeKey);
            dedupedRows.push(row);
        }
    }

    console.log(`[QueryPruner]    After:  ${dedupedRows.length} rows (removed ${rows.length - dedupedRows.length} join duplicates)`);

    return {
        rows: dedupedRows,
        pruned: true,
        log: `Dimension-table query: deduped ${rows.length} → ${dedupedRows.length} rows (table: "${singleTable}")`,
        sourceTable: singleTable,
    };
}
