import { ColumnType, ETLLog, RelatedTable } from '../types';
import { runETLPipeline } from './etlPipeline';

export interface RelationalNormalizationResult {
    tables: RelatedTable[];
    logs: ETLLog[];
}

/**
 * Normalize every source table before relationship discovery/materialization.
 * This prevents a relational workbook from carrying numeric/date strings into
 * joins and DuckDB merely because its sheets were imported as separate tables.
 */
export function normalizeRelatedTables(
    tables: RelatedTable[],
    fileName: string,
    overrides: Record<string, Record<string, ColumnType>> = {},
): RelationalNormalizationResult {
    const logs: ETLLog[] = [];
    const normalized = tables.map(table => {
        const result = runETLPipeline(
            table.rows.map(row => ({ ...row })),
            `${fileName} / ${table.name}`,
            overrides[table.name],
            { preserveRowMultiplicity: true },
        );
        logs.push(...result.logs.map(entry => ({
            ...entry,
            step: `${table.name} · ${entry.step}`,
        })));
        return {
            name: table.name,
            rows: result.rows,
            columns: result.columns.map(column => column.name),
            columnDefinitions: result.columns,
        };
    });
    return { tables: normalized, logs };
}
