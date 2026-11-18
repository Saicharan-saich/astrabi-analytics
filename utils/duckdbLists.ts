import { finiteOrNull } from './numberSafety';

/**
 * A LIST(...) cell from DuckDB as a plain array. Read entry by entry so a
 * blank (NULL) stays null: the raw buffer behind an Arrow vector (toArray)
 * holds leftover bytes in blank slots, which read as nonsense like 1e302.
 */
export function listValues(vector: { length: number; get(index: number): unknown }): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < vector.length; i++) {
        const item = vector.get(i);
        out.push(typeof item === 'bigint' ? Number(item) : typeof item === 'number' ? finiteOrNull(item) : item ?? null);
    }
    return out;
}
