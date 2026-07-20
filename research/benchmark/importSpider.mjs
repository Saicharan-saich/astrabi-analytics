#!/usr/bin/env node
/**
 * Official Spider / BIRD → Benchmark Lab importer.
 * ─────────────────────────────────────────────────────────────────────
 * Converts an official text-to-SQL split into the self-contained JSON the
 * Benchmark Lab loads via "Import official (JSON)". Dependency-free.
 *
 * INPUTS
 *   --questions dev.json        Spider/BIRD dev file: [{ db_id, question, query }]
 *   --databases databases.json  { [db_id]: { [tableName]: [ {col: val}, ... ] } }
 *   --suite spider|spider2|bird (default: spider)
 *   --limit N                   only the first N questions (optional)
 *   --out cases.json            output path (default: ./cases.json)
 *
 * PRODUCING databases.json FROM SPIDER'S SQLITE (no extra deps beyond sqlite3):
 *   for each table T in each <db>.sqlite:
 *     sqlite3 -json <db>.sqlite "SELECT * FROM T" > T.json
 *   then assemble { db_id: { T: <rows> } } — a tiny helper is left as an
 *   exercise, or use any sqlite→json dump. Keep rows small for a fast dev run.
 *
 * NOTE ON JOINS: joinEdges are not emitted — the Lab's autoJoinDatasets falls
 * back to fact-first name matching, which handles star schemas. For snowflake
 * schemas with ambiguous keys, add joinEdges by hand to the emitted cases.
 *
 * Usage:
 *   node research/benchmark/importSpider.mjs \
 *     --questions dev.json --databases databases.json --suite spider --out cases.json
 */

import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, def) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const questionsPath = arg('questions');
const databasesPath = arg('databases');
const suite = arg('suite', 'spider');
const limit = Number(arg('limit', '0')) || 0;
const outPath = arg('out', './cases.json');

if (!questionsPath || !databasesPath) {
    console.error('Missing --questions and/or --databases. See header for usage.');
    process.exit(1);
}

const questions = JSON.parse(readFileSync(questionsPath, 'utf8'));
const databases = JSON.parse(readFileSync(databasesPath, 'utf8'));

/** Tables referenced by a SQL string (FROM / JOIN targets, alias-stripped). */
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
    if (windowFn || nested) return 'extra';
    if (joins >= 2) return 'hard';
    if (joins === 1 || /\bgroup by\b/.test(s)) return 'medium';
    return 'easy';
}

const cases = [];
let skipped = 0;
for (const q of questions) {
    const dbId = q.db_id || q.database_id || q.db;
    const query = q.query || q.SQL || q.sql;
    const question = q.question;
    if (!dbId || !query || !question) { skipped++; continue; }

    const dbTables = databases[dbId];
    if (!dbTables) { skipped++; continue; }

    // Only include the tables this DB actually has; the runner loads them all
    // and executes the gold SQL against them for ground truth.
    const tables = Object.entries(dbTables).map(([name, rows]) => ({ name, rows }));
    if (tables.length === 0) { skipped++; continue; }

    // Largest table = the single-table "primary" fed to the pipeline for
    // single-table questions; multi-table ones are denormalized first.
    const primary = tables.slice().sort((a, b) => b.rows.length - a.rows.length)[0].name;
    const refCount = referencedTables(query).size || 1;

    cases.push({
        id: `${suite}-${dbId}-${cases.length}`,
        suite,
        db: dbId,
        question,
        goldSQL: query,
        difficulty: difficultyFromSQL(query),
        tableCount: Math.min(refCount, tables.length),
        tables,
        primaryTable: primary,
        orderMatters: /\border\s+by\b/i.test(query),
        tags: ['official'],
    });

    if (limit && cases.length >= limit) break;
}

writeFileSync(outPath, JSON.stringify(cases, null, 2));
console.log(`Wrote ${cases.length} cases → ${outPath} (skipped ${skipped}).`);
console.log(`Load it in the Benchmark Lab → ${suite} → "Import official (JSON)".`);
