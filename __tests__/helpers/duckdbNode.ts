/**
 * DuckDB-WASM (Node blocking build) test harness. Lets tests execute generated
 * SQL against the SAME engine the app uses in the browser, so SQL syntax /
 * dialect bugs are caught for real instead of by eyeballing strings.
 */
import * as duck from '@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs';
import path from 'path';
import { fileURLToPath } from 'url';

const DIST = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../node_modules/@duckdb/duckdb-wasm/dist',
);

export interface DuckHandle {
    query: (sql: string) => any[];
    loadTable: (name: string, rows: Record<string, any>[]) => void;
    close: () => void;
}

export async function createDuck(): Promise<DuckHandle> {
    const bundles = {
        mvp: { mainModule: `${DIST}/duckdb-mvp.wasm`, mainWorker: `${DIST}/duckdb-node-mvp.worker.cjs` },
        eh: { mainModule: `${DIST}/duckdb-eh.wasm`, mainWorker: `${DIST}/duckdb-node-eh.worker.cjs` },
    };
    const db = await duck.createDuckDB(bundles, new duck.VoidLogger(), duck.NODE_RUNTIME);
    await db.instantiate(() => {});
    const conn = db.connect();

    return {
        query(sql: string) {
            return conn.query(sql).toArray().map((r: any) => (r.toJSON ? r.toJSON() : r));
        },
        loadTable(name: string, rows: Record<string, any>[]) {
            conn.query(`DROP TABLE IF EXISTS "${name}"`);
            if (rows.length === 0) return;
            // Infer a column type per field from the first non-null value. Avoids
            // the json/csv extensions (which can't autoload offline in WASM).
            const cols = Object.keys(rows[0]);
            const typeOf = (field: string): string => {
                // Scan ALL values, not just the first — a column whose first value
                // is 0 (integer) but which holds fractions must be DOUBLE, not BIGINT
                // (otherwise the fractions truncate).
                const vals = rows.map(r => r[field]).filter(x => x !== null && x !== undefined && x !== '');
                if (vals.length === 0) return 'VARCHAR';
                if (vals.every(v => typeof v === 'number')) {
                    return vals.every(v => Number.isInteger(v)) ? 'BIGINT' : 'DOUBLE';
                }
                if (vals.every(v => typeof v === 'boolean')) return 'BOOLEAN';
                if (vals.every(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?/.test(v))) return 'DATE';
                return 'VARCHAR';
            };
            const colTypes = Object.fromEntries(cols.map(c => [c, typeOf(c)]));
            const ddl = cols.map(c => `"${c}" ${colTypes[c]}`).join(', ');
            conn.query(`CREATE TABLE "${name}" (${ddl})`);
            const lit = (val: any, type: string): string => {
                if (val === null || val === undefined) return 'NULL';
                if (type === 'BIGINT' || type === 'DOUBLE') return String(val);
                if (type === 'BOOLEAN') return val ? 'TRUE' : 'FALSE';
                if (type === 'DATE') return `DATE '${String(val).slice(0, 10)}'`;
                return `'${String(val).replace(/'/g, "''")}'`;
            };
            const values = rows.map(r => `(${cols.map(c => lit(r[c], colTypes[c])).join(', ')})`).join(', ');
            conn.query(`INSERT INTO "${name}" VALUES ${values}`);
        },
        close() {
            try { conn.close(); } catch { /* ignore */ }
            try { db.terminate(); } catch { /* ignore */ }
        },
    };
}
