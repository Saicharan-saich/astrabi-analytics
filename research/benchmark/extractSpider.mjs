#!/usr/bin/env node
/**
 * Official Spider → Benchmark Lab bundle extractor.
 * ─────────────────────────────────────────────────────────────────────
 * Reads a Spider release straight from disk (no manual JSON dumping) using
 * Node 22's built-in `node:sqlite`, and emits ONE compact bundle the Benchmark
 * Lab imports via "Import official (JSON)".
 *
 * Expected Spider layout (the standard release):
 *   spider/
 *     dev.json                              [{ db_id, question, query }, ...]
 *     database/<db_id>/<db_id>.sqlite       one SQLite file per database
 *
 * Output bundle (tables stored ONCE per database, not per question):
 *   {
 *     "suite": "spider",
 *     "databases": { "<db_id>": { "<table>": [ {col: val}, ... ] } },
 *     "cases": [ { id, db, question, goldSQL, difficulty, tableCount,
 *                  primaryTable, orderMatters, tags } ]
 *   }
 *
 * Usage:
 *   node research/benchmark/extractSpider.mjs \
 *     --spider-dir ./spider --split dev --out spider_dev.bundle.json \
 *     [--limit 500] [--max-rows 2000] [--suite spider]
 *
 * Notes on fidelity:
 *  - Gold AND generated SQL are executed against the SAME loaded tables in the
 *    Lab, so accuracy is measured consistently even if you cap rows.
 *  - --max-rows caps per table to keep the import light. Capping can break
 *    foreign-key matches (a fact row may reference a dropped dim row), which can
 *    make some joins return empty on BOTH sides. Prefer NO cap for the truest
 *    numbers; cap only if a database is huge. Dev databases are usually small.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

const spiderDir = arg('spider-dir');
const split = arg('split', 'dev');
const out = arg('out', `spider_${split}.bundle.json`);
const limit = Number(arg('limit', '0')) || 0;
const maxRows = Number(arg('max-rows', '0')) || 0; // 0 = no cap
const suite = arg('suite', 'spider');

if (!spiderDir) {
    console.error('Missing --spider-dir <path to Spider release>. See header for usage.');
    process.exit(1);
}

const questionsPath = join(spiderDir, `${split}.json`);
if (!existsSync(questionsPath)) {
    console.error(`Not found: ${questionsPath}. Expected Spider's ${split}.json there.`);
    process.exit(1);
}

const questions = JSON.parse(readFileSync(questionsPath, 'utf8'));

/** Tables referenced in a SQL string (FROM/JOIN targets). */
function referencedTables(sql) {
    const names = new Set();
    const re = /\b(?:from|join)\s+([a-zA-Z_][\w]*)/gi;
    let m;
    while ((m = re.exec(sql))) names.add(m[1].toLowerCase());
    return names;
}

function difficultyFromSQL(sql) {
    const s = sql.toLowerCase();
    const joins = (s.match(/\bjoin\b/g) || []).length;
    const nested = /\bselect\b[\s\S]*\bselect\b/.test(s);
    const windowFn = /\bover\s*\(/.test(s);
    if (windowFn || nested || /\b(intersect|except|union)\b/.test(s)) return 'extra';
    if (joins >= 2) return 'hard';
    if (joins === 1 || /\bgroup by\b/.test(s)) return 'medium';
    return 'easy';
}

/** JSON-safe coercion for SQLite values (BigInt → Number, Buffer → null). */
function coerce(v) {
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Uint8Array || Buffer.isBuffer?.(v)) return null;
    return v;
}

// Read + cache each database's tables once.
const dbCache = new Map(); // db_id → { table: rows } | null (missing)
function loadDatabase(dbId) {
    if (dbCache.has(dbId)) return dbCache.get(dbId);
    const file = join(spiderDir, 'database', dbId, `${dbId}.sqlite`);
    if (!existsSync(file)) {
        console.warn(`  ! missing sqlite for db "${dbId}" (${file}) — skipping its questions`);
        dbCache.set(dbId, null);
        return null;
    }
    const tables = {};
    try {
        const db = new DatabaseSync(file, { readOnly: true });
        const tableNames = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .all()
            .map(r => r.name);
        for (const name of tableNames) {
            const sql = `SELECT * FROM "${name}"` + (maxRows ? ` LIMIT ${maxRows}` : '');
            const rows = db.prepare(sql).all().map(row => {
                const o = {};
                for (const [k, val] of Object.entries(row)) o[k] = coerce(val);
                return o;
            });
            tables[name] = rows;
        }
        db.close();
    } catch (e) {
        console.warn(`  ! failed to read db "${dbId}": ${e.message}`);
        dbCache.set(dbId, null);
        return null;
    }
    dbCache.set(dbId, tables);
    return tables;
}

const databases = {};
const cases = [];
let skipped = 0;

for (const q of questions) {
    const dbId = q.db_id || q.database_id || q.db;
    const query = q.query || q.SQL || q.sql;
    const question = q.question;
    if (!dbId || !query || !question) { skipped++; continue; }

    const tables = loadDatabase(dbId);
    if (!tables || Object.keys(tables).length === 0) { skipped++; continue; }

    // Store this db's tables in the shared pool once.
    if (!databases[dbId]) databases[dbId] = tables;

    // Largest table = single-table "primary"; multi-table is denormalized first.
    const primary = Object.entries(tables).sort((a, b) => b[1].length - a[1].length)[0][0];
    const refCount = referencedTables(query).size || 1;

    cases.push({
        id: `${suite}-${dbId}-${cases.length}`,
        suite,
        db: dbId,
        question,
        goldSQL: query,
        difficulty: difficultyFromSQL(query),
        tableCount: Math.min(refCount, Object.keys(tables).length),
        primaryTable: primary,
        orderMatters: /\border\s+by\b/i.test(query),
        tags: ['official'],
    });

    if (limit && cases.length >= limit) break;
}

const bundle = { suite, databases, cases };
writeFileSync(out, JSON.stringify(bundle));

const totalRows = Object.values(databases).reduce(
    (s, tbls) => s + Object.values(tbls).reduce((a, r) => a + r.length, 0), 0);
console.log(`✓ ${cases.length} cases across ${Object.keys(databases).length} databases → ${out}`);
console.log(`  (${totalRows.toLocaleString()} rows total, ${skipped} questions skipped)`);
console.log(`Import it in the Benchmark Lab → ${suite} → "Import official (JSON)".`);
