/**
 * Small, dependency-free helpers over the SemanticModel, shared across the
 * mapper, correction engine, and guards (kept here to avoid import cycles).
 */
import type { SemanticModel } from './types';

/** A column that is (near-)unique per row — a row identifier like order_id.
 *  Such a column is never a meaningful group-by dimension: grouping by it yields
 *  one group per row and wrecks aggregate-filter / contribution knobs. */
export function isRowIdentifier(name: string, model: SemanticModel): boolean {
    const f = model.fields.find(fl => fl.name.toLowerCase() === name.toLowerCase());
    if (!f) return false;
    const rows = model.rowCount || 0;
    return f.semanticType === 'identifier' && rows > 0 && (f.distinctCount ?? 0) >= rows * 0.9;
}
