/**
 * Text-to-SQL benchmark runner.
 * ─────────────────────────────────────────────────────────────────────
 * For each case:
 *   1. Stand up the mini-database and execute the GOLD SQL for ground truth.
 *   2. Hand the primary table to the real AI-SQL pipeline (the same code path
 *      the product uses) and capture its predicted SQL + result + tokens.
 *   3. Compare via execution/denotation accuracy (resultCompare).
 *
 * Everything runs in the browser against DuckDB-WASM and the app's live LLM
 * config — so this measures the shipping system, not a mock.
 */

import type { Dataset } from '../../types';
import { BenchCase } from './spiderCases';
import { compareResults } from './resultCompare';
import { loadBenchmarkTables, runRawSQLViaDuckDB, clearBenchmarkTables } from '../duckdbEngine';
import { runAISQLPipeline } from '../ai-sql/pipeline';
import { runETLPipeline } from '../etlPipeline';
import { autoJoinDatasets } from '../analysisEngine';
import { classifyFailure, FailureCategory, FAILURE_LABELS } from './errorClassifier';
import { resampleTables, mulberry32, RTable } from './resample';
import { toDuckDBDialect } from './sqlDialect';
import { serializeSchema } from '../ai-sql/schemaSerializer';
import { generateDirectSQL } from '../ai-sql/directSqlEngine';

export type BenchEngine = 'plan' | 'sql';

export interface RunOptions {
    /** Number of database instances for test-suite accuracy (1 = original only). */
    testSuiteInstances?: number;
    /** Timed repetitions when measuring VES execution efficiency. */
    vesRuns?: number;
    /** Which engine produces the prediction: the analytical plan engine (default)
     *  or the direct SQL-semantics engine. */
    engine?: BenchEngine;
}

export interface CaseResult {
    id: string;
    question: string;
    suite: BenchCase['suite'];
    difficulty: BenchCase['difficulty'];
    tableCount: number;
    tags: string[];
    match: boolean;
    reason: string;
    expectedRows: number;
    actualRows: number;
    goldSQL: string;
    predictedSQL: string;
    latencyMs: number;
    tokens: number;
    error?: string;
    /** SQL executed without throwing (independent of whether it was correct). */
    executed: boolean;
    /** Pipeline self-repair attempts before the SQL ran. */
    repairAttempts: number;
    /** Pipeline confidence 0..100 (semantic-match proxy). */
    confidence: number;
    /** Why it failed (or 'correct'). */
    failCategory: FailureCategory;
    failDetail: string;
    /** BIRD Valid Efficiency Score reward = sqrt(t_gold / t_pred); 0 if incorrect. */
    vesReward: number;
    /** Instances the test-suite check ran against (1 = single-instance only). */
    testSuiteInstances: number;
    /** Matched gold on ALL test-suite instances (robust to coincidence). */
    robustMatch: boolean;
    expectedSample: Record<string, any>[];
    actualSample: Record<string, any>[];
}

export interface BenchmarkProgress {
    done: number;
    total: number;
    current: string;
}

/**
 * Build the Dataset the pipeline consumes — REPLICATING THE REAL APP PATH:
 *   • single-table case → that table,
 *   • multi-table case  → the denormalized master table produced by the same
 *     autoJoinDatasets() the connector uses (fact-first LEFT JOIN cascade).
 * The pipeline is single-table; the app makes multi-table work by widening first.
 */
function buildDataset(c: BenchCase, tablesOverride?: RTable[]): { dataset: Dataset; masterRows: number; joinLogs: string[] } {
    const srcTables = tablesOverride || c.tables;
    let rows: Record<string, any>[];
    let name: string;
    let joinLogs: string[] = [];

    // Branch on how many tables the QUESTION needs (tableCount), NOT how many
    // tables the database happens to contain. A single-table question must be
    // answered against just its primary table — otherwise the whole database
    // gets denormalized and the pipeline analyses the wrong (biggest) table.
    if (c.tableCount > 1) {
        const tableMap: Record<string, any[]> = {};
        for (const t of srcTables) tableMap[t.name] = t.rows;
        const joined = autoJoinDatasets(tableMap, c.joinEdges);
        rows = joined.mergedRows;
        joinLogs = joined.joinLogs;
        name = `${c.db}_master`;
    } else {
        const primary = srcTables.find(t => t.name === c.primaryTable) || srcTables[0];
        rows = primary.rows;
        name = primary.name;
    }

    const etl = runETLPipeline(rows, `${name}.csv`);
    const dataset = {
        id: `bench_${c.id}`,
        name,
        rows: etl.rows,
        columns: etl.columns,
        totalRows: etl.rows.length,
        etlLogs: etl.logs || [],
        timeContext: etl.timeContext,
        createdAt: Date.now(),
        version: 1,
    } as unknown as Dataset;

    return { dataset, masterRows: rows.length, joinLogs };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Average execution time (ms) of a SQL over N runs; floored so tiny data ≠ 0. */
async function timeExec(sql: string, runs: number): Promise<number> {
    let total = 0;
    for (let i = 0; i < runs; i++) {
        const t0 = now();
        const r = await runRawSQLViaDuckDB(sql);
        total += now() - t0;
        if (r.error) return NaN; // can't time a failing query
    }
    return Math.max(0.01, total / runs);
}

export async function runBenchmarkCase(c: BenchCase, opts: RunOptions = {}): Promise<CaseResult> {
    const K = Math.max(1, Math.floor(opts.testSuiteInstances || 1));
    const vesRuns = Math.max(1, Math.floor(opts.vesRuns || 3));

    let predictedSQL = '';
    let tokens = 0;
    let repairAttempts = 0;
    let confidence = 0;
    let error: string | undefined;
    let expected: Record<string, any>[] = [];
    let actual: Record<string, any>[] = [];

    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
        // Clean slate for this case (loadBenchmarkTables drops+recreates each of
        // its own tables; we also clear the pipeline's "data"/"dim_date" cache).
        await clearBenchmarkTables(c.tables.map(t => t.name));
        await loadBenchmarkTables(c.tables);
        const gold = await runRawSQLViaDuckDB(toDuckDBDialect(c.goldSQL));
        if (gold.error) throw new Error(`Gold SQL failed: ${gold.error}`);
        expected = gold.data || [];

        if (opts.engine === 'sql') {
            // Direct SQL-semantics engine: schema-only → LLM SQL → run on the
            // ORIGINAL multi-table database (real joins), no denormalization.
            const schema = serializeSchema(c.tables, c.joinEdges);
            const gen = await generateDirectSQL(c.question, schema);
            predictedSQL = gen.sql;
            tokens = gen.tokens;
            if (gen.error) throw new Error(gen.error);
            const exec = await runRawSQLViaDuckDB(toDuckDBDialect(gen.sql));
            if (exec.error) throw new Error(exec.error);
            actual = exec.data || [];
        } else {
            // Analytical plan engine — denormalize (if multi-table) exactly like the
            // app, then run the pipeline on the resulting single wide table.
            const { dataset } = buildDataset(c);
            const result = await runAISQLPipeline(c.question, dataset);
            predictedSQL = result.sql || '';
            tokens = result.tokenUsage?.total || 0;
            repairAttempts = result.repairAttempts || 0;
            confidence = result.confidence?.score || 0;
            actual = (result.rawData && result.rawData.length ? result.rawData : result.chartData) || [];
        }
    } catch (e: any) {
        error = e?.message || String(e);
    }
    const latencyMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);

    const cmp = error
        ? { match: false, reason: error, expectedRows: expected.length, actualRows: actual.length }
        : compareResults(expected, actual, { orderMatters: c.orderMatters });

    const expectedSample = expected.slice(0, 8);
    const actualSample = actual.slice(0, 8);
    const cls = classifyFailure({
        match: cmp.match, error, reason: cmp.reason, tableCount: c.tableCount,
        expectedRows: cmp.expectedRows, actualRows: cmp.actualRows, expectedSample, actualSample,
    });

    // ── VES (Valid Efficiency Score) — reward only CORRECT predictions ──
    // Runs BEFORE the test-suite loop, while the original tables + "data" master
    // are still the loaded instance.
    let vesReward = 0;
    if (cmp.match && predictedSQL && !error) {
        try {
            const tGold = await timeExec(toDuckDBDialect(c.goldSQL), vesRuns);
            const tPred = await timeExec(predictedSQL, vesRuns);
            vesReward = (isFinite(tGold) && isFinite(tPred) && tPred > 0)
                ? Math.min(2, Math.max(0, Math.sqrt(tGold / tPred)))  // clamp noisy tiny-data ratios
                : 1;                                                   // couldn't distinguish → neutral
        } catch { vesReward = 1; }
    }

    // ── Test-suite (multi-instance) robustness ──
    // Only bother if the original instance matched — a fail is already incorrect.
    let robustMatch = cmp.match;
    let instancesRun = 1;
    if (K > 1 && cmp.match && predictedSQL && !error) {
        const rng = mulberry32(hashSeed(c.id));
        const names = c.tables.map(t => t.name);
        for (let k = 1; k < K && robustMatch; k++) {
            let matched: boolean | null = null;
            for (let attempt = 0; attempt < 3 && matched === null; attempt++) {
                const resampled = resampleTables(c.tables as RTable[], rng);
                try {
                    await clearBenchmarkTables([...names, 'data', 'master']);
                    await loadBenchmarkTables(resampled);
                    const goldR = await runRawSQLViaDuckDB(toDuckDBDialect(c.goldSQL));
                    if (goldR.error || (goldR.data || []).length === 0) continue; // non-informative resample
                    let predR;
                    if (opts.engine === 'sql') {
                        // Direct-SQL prediction runs on the ORIGINAL (resampled) tables.
                        predR = await runRawSQLViaDuckDB(toDuckDBDialect(predictedSQL));
                    } else {
                        const { dataset: dsR } = buildDataset(c, resampled);
                        await loadBenchmarkTables([{ name: 'data', rows: dsR.rows }]);
                        predR = await runRawSQLViaDuckDB(predictedSQL);
                    }
                    matched = compareResults(goldR.data || [], predR.data || [], { orderMatters: c.orderMatters }).match;
                } catch { matched = false; }
            }
            if (matched === false) robustMatch = false;
            if (matched !== null) instancesRun++;
        }
    }

    return {
        id: c.id, question: c.question, suite: c.suite, difficulty: c.difficulty,
        tableCount: c.tableCount, tags: c.tags,
        match: cmp.match, reason: cmp.reason,
        expectedRows: cmp.expectedRows, actualRows: cmp.actualRows,
        goldSQL: c.goldSQL, predictedSQL, latencyMs, tokens, error,
        executed: !error, repairAttempts, confidence,
        failCategory: cls.category, failDetail: cls.detail,
        vesReward, testSuiteInstances: instancesRun, robustMatch,
        expectedSample, actualSample,
    };
}

/** Small deterministic string→int hash for a reproducible resample seed. */
function hashSeed(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

export async function runBenchmark(
    cases: BenchCase[],
    onProgress?: (p: BenchmarkProgress) => void,
    opts: RunOptions = {},
): Promise<CaseResult[]> {
    const results: CaseResult[] = [];
    for (let i = 0; i < cases.length; i++) {
        onProgress?.({ done: i, total: cases.length, current: cases[i].question });
        // Sequential on purpose: DuckDB tables + the "data" table are shared state.
        // eslint-disable-next-line no-await-in-loop
        results.push(await runBenchmarkCase(cases[i], opts));
    }
    const allNames = [...new Set(cases.flatMap(c => c.tables.map(t => t.name)))];
    await clearBenchmarkTables(allNames);
    onProgress?.({ done: cases.length, total: cases.length, current: 'Done' });
    return results;
}

// ── Aggregation ──────────────────────────────────────────────────────

export interface Bucket { label: string; total: number; passed: number; }

export interface FailBucket { category: FailureCategory; label: string; count: number; }

export interface BenchmarkSummary {
    total: number;
    passed: number;
    accuracy: number;              // 0..1 (execution accuracy)
    executionSuccess: number;      // 0..1 (SQL ran without throwing)
    repairRate: number;            // 0..1 (needed ≥1 self-repair)
    avgLatencyMs: number;
    totalTokens: number;
    avgTokens: number;
    avgConfidence: number;         // 0..100 (semantic-match proxy)
    /** BIRD Valid Efficiency Score, 0..1 (mean of correct-weighted efficiency reward). */
    ves: number;
    /** Test-suite accuracy 0..1 — matched gold on ALL instances (0 if K=1: same as accuracy). */
    testSuiteAccuracy: number;
    /** Max instances any case was evaluated on (1 = test-suite disabled). */
    testSuiteInstances: number;
    bySuite: Bucket[];
    byDifficulty: Bucket[];
    byTableClass: Bucket[];        // single-table vs multi-table
    failureBreakdown: FailBucket[];
    errors: number;
}

function bucket(results: CaseResult[], label: string, pred: (r: CaseResult) => boolean): Bucket {
    const sub = results.filter(pred);
    return { label, total: sub.length, passed: sub.filter(r => r.match).length };
}

export function summarize(results: CaseResult[]): BenchmarkSummary {
    const total = results.length;
    const passed = results.filter(r => r.match).length;
    const totalTokens = results.reduce((s, r) => s + (r.tokens || 0), 0);
    const totalLatency = results.reduce((s, r) => s + (r.latencyMs || 0), 0);
    const executed = results.filter(r => r.executed).length;
    const repaired = results.filter(r => (r.repairAttempts || 0) > 0).length;
    const totalConfidence = results.reduce((s, r) => s + (r.confidence || 0), 0);
    // VES = mean over ALL cases of (correct ? efficiency reward : 0) — BIRD convention.
    const vesSum = results.reduce((s, r) => s + (r.match ? (r.vesReward || 0) : 0), 0);
    const robust = results.filter(r => r.robustMatch).length;
    const maxInstances = results.reduce((m, r) => Math.max(m, r.testSuiteInstances || 1), 1);
    const diffs: BenchCase['difficulty'][] = ['easy', 'medium', 'hard', 'extra'];

    // Failure breakdown across the taxonomy (only categories that occur).
    const failCounts = new Map<FailureCategory, number>();
    for (const r of results) failCounts.set(r.failCategory, (failCounts.get(r.failCategory) || 0) + 1);
    const failureBreakdown: FailBucket[] = [...failCounts.entries()]
        .filter(([cat]) => cat !== 'correct')
        .map(([category, count]) => ({ category, label: FAILURE_LABELS[category], count }))
        .sort((a, b) => b.count - a.count);

    return {
        total,
        passed,
        accuracy: total ? passed / total : 0,
        executionSuccess: total ? executed / total : 0,
        repairRate: total ? repaired / total : 0,
        avgLatencyMs: total ? Math.round(totalLatency / total) : 0,
        totalTokens,
        avgTokens: total ? Math.round(totalTokens / total) : 0,
        avgConfidence: total ? Math.round(totalConfidence / total) : 0,
        ves: total ? vesSum / total : 0,
        testSuiteAccuracy: total ? robust / total : 0,
        testSuiteInstances: maxInstances,
        errors: results.filter(r => r.error).length,
        failureBreakdown,
        bySuite: [
            bucket(results, 'Spider-style', r => r.suite === 'spider'),
            bucket(results, 'Spider 2.0-style', r => r.suite === 'spider2'),
            bucket(results, 'BIRD-style', r => r.suite === 'bird'),
            bucket(results, 'Internal Sales', r => r.suite === 'internal'),
            bucket(results, 'User', r => r.suite === 'user'),
        ].filter(b => b.total > 0),
        byDifficulty: diffs.map(d => bucket(results, d, r => r.difficulty === d)).filter(b => b.total > 0),
        byTableClass: [
            bucket(results, 'Single-table', r => r.tableCount === 1),
            bucket(results, 'Multi-table', r => r.tableCount > 1),
        ].filter(b => b.total > 0),
    };
}

/** CSV export of the per-case results for offline analysis. */
export function resultsToCSV(results: CaseResult[]): string {
    const head = ['id', 'suite', 'difficulty', 'tables', 'match', 'robust_match', 'ves_reward', 'ts_instances', 'latency_ms', 'tokens', 'question', 'gold_sql', 'predicted_sql', 'reason'];
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = results.map(r => [
        r.id, r.suite, r.difficulty, r.tableCount, r.match ? 1 : 0, r.robustMatch ? 1 : 0,
        (r.vesReward ?? 0).toFixed(3), r.testSuiteInstances ?? 1, r.latencyMs, r.tokens,
        r.question, r.goldSQL, r.predictedSQL, r.error || r.reason,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
}
