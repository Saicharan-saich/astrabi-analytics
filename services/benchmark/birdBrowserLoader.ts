/**
 * BIRD loader — browser glue.
 * Initializes sql.js (WASM SQLite) and reads the user's downloaded BIRD `dev/`
 * folder entirely in the browser: parse dev.json, read only the .sqlite files
 * actually needed, and hand off to the pure builder in birdLoader.ts.
 *
 * Nothing is uploaded anywhere — File objects come from a local <input
 * webkitdirectory> pick, and only column metadata ever reaches the LLM.
 */
import initSqlJs from 'sql.js';
// Vite resolves this to the hashed asset URL of the wasm binary.
// @ts-ignore - ?url is a Vite import suffix
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { BenchCase } from './spiderCases';
import type { JoinEdge } from '../analysisEngine';
import { readSqliteTables, readSqliteForeignKeys, buildBirdCases, BirdQuestion } from './birdLoader';

let _sql: Promise<any> | null = null;
function getSQL(): Promise<any> {
    if (!_sql) _sql = initSqlJs({ locateFile: () => sqlWasmUrl as string });
    return _sql;
}

export interface BirdLoadOptions {
    /** Cap how many questions to load (keeps only the DBs those questions need). */
    loadLimit?: number;
    /** Cap rows read per table (0 = all). */
    maxRows?: number;
    onProgress?: (msg: string) => void;
}

function pathOf(f: File): string {
    return (f as any).webkitRelativePath || f.name;
}

/**
 * Load BIRD cases from the files of a picked `dev/` directory.
 * @param files  the FileList/array from an <input type=file webkitdirectory>
 */
export async function loadBirdFromFiles(files: File[], opts: BirdLoadOptions = {}): Promise<BenchCase[]> {
    const onProgress = opts.onProgress || (() => { });
    const loadLimit = opts.loadLimit ?? 200;

    // 1. Locate dev.json (BIRD's question file).
    const devJson = files.find(f => /(^|\/)dev\.json$/.test(pathOf(f)))
        || files.find(f => f.name === 'dev.json');
    if (!devJson) throw new Error('dev.json not found in the selected folder — pick BIRD\'s unzipped dev/ folder.');

    onProgress('Reading dev.json…');
    const allQuestions: BirdQuestion[] = JSON.parse(await devJson.text());
    if (!Array.isArray(allQuestions) || allQuestions.length === 0) throw new Error('dev.json is empty or malformed');

    // 2. Keep only as many questions as requested; find the DBs they need.
    const questions = loadLimit > 0 ? allQuestions.slice(0, loadLimit) : allQuestions;
    const neededDbIds = [...new Set(questions.map(q => q.db_id).filter(Boolean))];

    // 3. Read only those .sqlite files.
    const SQL = await getSQL();
    const databases: Record<string, Record<string, any[]>> = {};
    const foreignKeys: Record<string, JoinEdge[]> = {};
    let done = 0;
    for (const dbId of neededDbIds) {
        const file = files.find(f => new RegExp(`(^|/)${dbId}/${dbId}\\.sqlite$`).test(pathOf(f)))
            || files.find(f => f.name === `${dbId}.sqlite`);
        if (!file) {
            onProgress(`⚠ missing ${dbId}.sqlite — skipping its questions`);
            continue;
        }
        onProgress(`Reading database ${dbId} (${++done}/${neededDbIds.length})…`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        databases[dbId] = readSqliteTables(SQL, bytes, opts.maxRows || 0);
        foreignKeys[dbId] = readSqliteForeignKeys(SQL, bytes);
    }

    // 4. Build cases (drops questions whose DB was missing).
    const cases = buildBirdCases(questions, databases, foreignKeys);
    onProgress(`Loaded ${cases.length} BIRD cases across ${Object.keys(databases).length} databases`);
    if (cases.length === 0) throw new Error('No runnable BIRD cases — check the folder structure (dev.json + dev_databases/<db>/<db>.sqlite).');
    return cases;
}
