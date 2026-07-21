/**
 * BIRD benchmark loader (pure core).
 * ─────────────────────────────────────────────────────────────────────
 * Turns a downloaded BIRD Dev release into Benchmark Lab cases, entirely
 * client-side. This file is PURE — it takes an already-initialized sql.js
 * instance and raw bytes, so it runs in Node tests as well as the browser.
 * The browser-only glue (initializing sql.js + reading File objects) lives in
 * birdBrowserLoader.ts.
 *
 * BIRD dev layout (https://bird-bench.github.io):
 *   dev/
 *     dev.json                              [{ db_id, question, evidence, SQL, difficulty }]
 *     dev_databases/<db_id>/<db_id>.sqlite
 *
 * BIRD questions often REQUIRE the `evidence` field (external knowledge) to be
 * answerable, so we attach it to the natural-language question as a hint — the
 * standard way BIRD systems consume it.
 */

import type { BenchCase } from './spiderCases';
import type { JoinEdge } from '../analysisEngine';

export interface BirdQuestion {
    db_id: string;
    question: string;
    evidence?: string;
    SQL?: string;
    sql?: string;
    difficulty?: string;
}

/** JSON-safe coercion for sql.js values (BigInt → Number, bytes → null). */
function coerce(v: any): any {
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Uint8Array) return null;
    return v;
}

/**
 * Extract every user table from an sql.js Database (built from .sqlite bytes).
 * @param SQL  an initialized sql.js module (initSqlJs() result)
 * @param bytes  the .sqlite file contents
 */
export function readSqliteTables(SQL: any, bytes: Uint8Array, maxRows = 0): Record<string, any[]> {
    const db = new SQL.Database(bytes);
    const tables: Record<string, any[]> = {};
    try {
        const nameRes = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
        const names: string[] = nameRes.length ? nameRes[0].values.map((r: any[]) => String(r[0])) : [];
        for (const name of names) {
            const sql = `SELECT * FROM "${name}"` + (maxRows ? ` LIMIT ${maxRows}` : '');
            const res = db.exec(sql);
            if (res.length) {
                const cols: string[] = res[0].columns;
                tables[name] = res[0].values.map((row: any[]) => {
                    const o: Record<string, any> = {};
                    for (let i = 0; i < cols.length; i++) o[cols[i]] = coerce(row[i]);
                    return o;
                });
            } else {
                tables[name] = [];
            }
        }
    } finally {
        db.close();
    }
    return tables;
}

/**
 * Read the FOREIGN KEYS of every table in an sql.js database. These are what let
 * the app denormalize multi-table questions correctly — BIRD join keys often
 * differ in name across tables (satscores.cds → schools.CDSCode), which the
 * name-match join can't discover, but the declared FK can.
 */
export function readSqliteForeignKeys(SQL: any, bytes: Uint8Array): JoinEdge[] {
    const db = new SQL.Database(bytes);
    const edges: JoinEdge[] = [];
    try {
        const names: string[] = (db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0]?.values || [])
            .map((r: any[]) => String(r[0]));
        for (const table of names) {
            const res = db.exec(`PRAGMA foreign_key_list("${table}")`);
            if (!res.length) continue;
            const cols: string[] = res[0].columns; // id, seq, table, from, to, ...
            const iTable = cols.indexOf('table');
            const iFrom = cols.indexOf('from');
            const iTo = cols.indexOf('to');
            for (const row of res[0].values) {
                const rightTable = String(row[iTable]);
                const leftColumn = String(row[iFrom]);
                const rightColumn = row[iTo] != null ? String(row[iTo]) : leftColumn;
                if (rightTable && leftColumn) {
                    edges.push({ leftTable: table, rightTable, leftColumn, rightColumn, type: 'fk' });
                }
            }
        }
    } finally {
        db.close();
    }
    return edges;
}

/** Map BIRD's difficulty labels to the Lab's scale. */
function mapDifficulty(d?: string): BenchCase['difficulty'] {
    switch ((d || '').toLowerCase()) {
        case 'simple': return 'easy';
        case 'moderate': return 'medium';
        case 'challenging': return 'hard';
        default: return 'medium';
    }
}

/** Table names referenced by a SQL string (FROM/JOIN targets), lowercased. */
export function referencedTableNames(sql: string): string[] {
    const names = new Set<string>();
    const re = /\b(?:from|join)\s+`?([a-zA-Z_][\w]*)`?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
    return [...names];
}

/**
 * Build Benchmark Lab cases from BIRD questions + already-read databases.
 * `databases` maps db_id → { tableName → rows }.
 */
export function buildBirdCases(
    questions: BirdQuestion[],
    databases: Record<string, Record<string, any[]>>,
    foreignKeys?: Record<string, JoinEdge[]>,
    opts?: { limit?: number },
): BenchCase[] {
    const cases: BenchCase[] = [];
    for (const q of questions) {
        const gold = q.SQL || q.sql;
        if (!q.db_id || !gold || !q.question) continue;
        const tblMap = databases[q.db_id];
        if (!tblMap || Object.keys(tblMap).length === 0) continue;

        const tables = Object.entries(tblMap).map(([name, rows]) => ({ name, rows }));

        // Primary table = the table the GOLD query actually reads (NOT the biggest
        // table in the database). For a single-table question this points the
        // pipeline at the right table; for multi-table it's the largest of the
        // referenced tables (the others are denormalized in).
        const refs = referencedTableNames(gold);
        const byName = new Map(tables.map(t => [t.name.toLowerCase(), t]));
        const referenced = refs.map(r => byName.get(r)).filter(Boolean) as { name: string; rows: any[] }[];
        const pool = referenced.length ? referenced : tables;
        const primary = [...pool].sort((a, b) => b.rows.length - a.rows.length)[0].name;
        const tableCount = Math.max(1, Math.min(referenced.length || 1, tables.length));

        // Real foreign keys for this database (both sides must be present tables),
        // so multi-table questions denormalize into a correct wide master.
        const present = new Set(tables.map(t => t.name.toLowerCase()));
        const joinEdges = (foreignKeys?.[q.db_id] || []).filter(
            e => present.has(e.leftTable.toLowerCase()) && present.has(e.rightTable.toLowerCase()),
        );

        // Attach BIRD's evidence as a hint (external knowledge the model may need).
        const question = q.evidence && q.evidence.trim()
            ? `${q.question}  (Hint: ${q.evidence.trim()})`
            : q.question;

        cases.push({
            id: `bird-${q.db_id}-${cases.length}`,
            suite: 'bird',
            db: q.db_id,
            question,
            goldSQL: gold,
            difficulty: mapDifficulty(q.difficulty),
            tableCount,
            tables,
            primaryTable: primary,
            joinEdges: joinEdges.length ? joinEdges : undefined,
            orderMatters: /\border\s+by\b/i.test(gold),
            tags: ['official', 'bird'],
        });
        if (opts?.limit && cases.length >= opts.limit) break;
    }
    return cases;
}
