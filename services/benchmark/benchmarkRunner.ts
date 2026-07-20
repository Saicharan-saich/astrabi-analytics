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
import { BenchCase, allBenchTableNames } from './spiderCases';
import { compareResults } from './resultCompare';
import { loadBenchmarkTables, runRawSQLViaDuckDB, clearBenchmarkTables } from '../duckdbEngine';
import { runAISQLPipeline } from '../ai-sql/pipeline';
import { runETLPipeline } from '../etlPipeline';

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
    expectedSample: Record<string, any>[];
    actualSample: Record<string, any>[];
}

export interface BenchmarkProgress {
    done: number;
    total: number;
    current: string;
}

/** Build a single-table Dataset (via the real ETL) for the pipeline to consume. */
function buildDataset(c: BenchCase): Dataset {
    const primary = c.tables.find(t => t.name === c.primaryTable) || c.tables[0];
    const etl = runETLPipeline(primary.rows, `${primary.name}.csv`);
    return {
        id: `bench_${c.id}`,
        name: primary.name,
        rows: etl.rows,
        columns: etl.columns,
        totalRows: etl.rows.length,
        etlLogs: etl.logs || [],
        timeContext: etl.timeContext,
        createdAt: Date.now(),
        version: 1,
    } as unknown as Dataset;
}

export async function runBenchmarkCase(c: BenchCase): Promise<CaseResult> {
    let predictedSQL = '';
    let tokens = 0;
    let error: string | undefined;
    let expected: Record<string, any>[] = [];
    let actual: Record<string, any>[] = [];

    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
        // Clean slate, then ground truth from the gold SQL.
        await clearBenchmarkTables(allBenchTableNames());
        await loadBenchmarkTables(c.tables);
        const gold = await runRawSQLViaDuckDB(c.goldSQL);
        if (gold.error) throw new Error(`Gold SQL failed: ${gold.error}`);
        expected = gold.data || [];

        // System prediction via the single-table pipeline.
        const dataset = buildDataset(c);
        const result = await runAISQLPipeline(c.question, dataset);
        predictedSQL = result.sql || '';
        tokens = result.tokenUsage?.total || 0;
        actual = (result.rawData && result.rawData.length ? result.rawData : result.chartData) || [];
    } catch (e: any) {
        error = e?.message || String(e);
    }
    const latencyMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start);

    const cmp = error
        ? { match: false, reason: error, expectedRows: expected.length, actualRows: actual.length }
        : compareResults(expected, actual, { orderMatters: c.orderMatters });

    return {
        id: c.id, question: c.question, suite: c.suite, difficulty: c.difficulty,
        tableCount: c.tableCount, tags: c.tags,
        match: cmp.match, reason: cmp.reason,
        expectedRows: cmp.expectedRows, actualRows: cmp.actualRows,
        goldSQL: c.goldSQL, predictedSQL, latencyMs, tokens, error,
        expectedSample: expected.slice(0, 8), actualSample: actual.slice(0, 8),
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
    await clearBenchmarkTables(allBenchTableNames());
    onProgress?.({ done: cases.length, total: cases.length, current: 'Done' });
    return results;
}

// ── Aggregation ──────────────────────────────────────────────────────

export interface Bucket { label: string; total: number; passed: number; }

export interface BenchmarkSummary {
    total: number;
    passed: number;
    accuracy: number;              // 0..1
    avgLatencyMs: number;
    totalTokens: number;
    avgTokens: number;
    bySuite: Bucket[];
    byDifficulty: Bucket[];
    byTableClass: Bucket[];        // single-table vs multi-table
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
    const diffs: BenchCase['difficulty'][] = ['easy', 'medium', 'hard', 'extra'];
    return {
        total,
        passed,
        accuracy: total ? passed / total : 0,
        avgLatencyMs: total ? Math.round(totalLatency / total) : 0,
        totalTokens,
        avgTokens: total ? Math.round(totalTokens / total) : 0,
        errors: results.filter(r => r.error).length,
        bySuite: [
            bucket(results, 'Spider-style', r => r.suite === 'spider'),
            bucket(results, 'Spider 2.0-style', r => r.suite === 'spider2'),
        ],
        byDifficulty: diffs.map(d => bucket(results, d, r => r.difficulty === d)),
        byTableClass: [
            bucket(results, 'Single-table', r => r.tableCount === 1),
            bucket(results, 'Multi-table', r => r.tableCount > 1),
        ],
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
