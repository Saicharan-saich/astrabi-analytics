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
function buildDataset(c: BenchCase): { dataset: Dataset; masterRows: number; joinLogs: string[] } {
    let rows: Record<string, any>[];
    let name: string;
    let joinLogs: string[] = [];

    if (c.tables.length > 1) {
        const tableMap: Record<string, any[]> = {};
        for (const t of c.tables) tableMap[t.name] = t.rows;
        const joined = autoJoinDatasets(tableMap, c.joinEdges);
        rows = joined.mergedRows;
        joinLogs = joined.joinLogs;
        name = `${c.db}_master`;
    } else {
        const primary = c.tables.find(t => t.name === c.primaryTable) || c.tables[0];
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

export async function runBenchmarkCase(c: BenchCase): Promise<CaseResult> {
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
        const gold = await runRawSQLViaDuckDB(c.goldSQL);
        if (gold.error) throw new Error(`Gold SQL failed: ${gold.error}`);
        expected = gold.data || [];

        // System prediction — denormalize (if multi-table) exactly like the app,
        // then run the pipeline on the resulting single wide table.
        const { dataset } = buildDataset(c);
        const result = await runAISQLPipeline(c.question, dataset);
        predictedSQL = result.sql || '';
        tokens = result.tokenUsage?.total || 0;
        repairAttempts = result.repairAttempts || 0;
        confidence = result.confidence?.score || 0;
        actual = (result.rawData && result.rawData.length ? result.rawData : result.chartData) || [];
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

    return {
        id: c.id, question: c.question, suite: c.suite, difficulty: c.difficulty,
        tableCount: c.tableCount, tags: c.tags,
        match: cmp.match, reason: cmp.reason,
        expectedRows: cmp.expectedRows, actualRows: cmp.actualRows,
        goldSQL: c.goldSQL, predictedSQL, latencyMs, tokens, error,
        executed: !error, repairAttempts, confidence,
        failCategory: cls.category, failDetail: cls.detail,
        expectedSample, actualSample,
    };
}

export async function runBenchmark(
    cases: BenchCase[],
    onProgress?: (p: BenchmarkProgress) => void,
): Promise<CaseResult[]> {
    const results: CaseResult[] = [];
    for (let i = 0; i < cases.length; i++) {
        onProgress?.({ done: i, total: cases.length, current: cases[i].question });
        // Sequential on purpose: DuckDB tables + the "data" table are shared state.
        // eslint-disable-next-line no-await-in-loop
        results.push(await runBenchmarkCase(cases[i]));
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
    const head = ['id', 'suite', 'difficulty', 'tables', 'match', 'latency_ms', 'tokens', 'question', 'gold_sql', 'predicted_sql', 'reason'];
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = results.map(r => [
        r.id, r.suite, r.difficulty, r.tableCount, r.match ? 1 : 0, r.latencyMs, r.tokens,
        r.question, r.goldSQL, r.predictedSQL, r.error || r.reason,
    ].map(esc).join(','));
    return [head.join(','), ...lines].join('\n');
}
