/**
 * AI SQL accuracy, measured on the pipeline people actually use (the AI SQL
 * screen's runLeanAISQL), with the real model, on full datasets in DuckDB.
 *
 * Each case: load the frozen dataset → re-run the gold SQL in DuckDB and check
 * it still gives the frozen answer → ask the question exactly as a user would
 * (no hints; a clarifying question is answered with its first option) → run
 * the AI's SQL on the raw table → compare with the gold answer.
 *
 * The comparison uses the AI's raw query result (yes/no not turned into words,
 * no 500-row display cap), so it measures the SQL, not the presentation.
 */
import { executeSQLViaDuckDB, reloadIsolatedBenchmarkData } from '../duckdbEngine';
import { runLeanAISQL } from '../ai-sql/leanPipeline';
import type { AISQLPipelineResult } from '../ai-sql/types';
import type { Dataset } from '../../types';
import { runBenchmark } from './runner';
import { loadResearchBenchmarkDataset } from './researchDatasetLoader';
import { BUSINESS_BENCHMARK_SUITE } from './businessFixtures.generated';
import { AUDITED_HOLDOUT_BENCHMARK_SUITES } from './holdoutQuality';
import type { BenchmarkCaseResult, BenchmarkRun, BenchmarkSuite } from './types';

/** The AI SQL screen's pipeline, as the benchmark runner expects it. */
export async function runCurrentAISQL(question: string, dataset: Dataset): Promise<AISQLPipelineResult> {
    const result = await runLeanAISQL(question, dataset, { autoChoose: true, requestPurpose: 'benchmark' });
    if (!result.sql?.trim()) return result;
    // Grade the SQL itself: the full raw result, before display labels and caps.
    const raw = await executeSQLViaDuckDB(dataset.rows, result.sql, dataset.timeContext ? {
        minDate: dataset.timeContext.minDate,
        maxDate: dataset.timeContext.maxDate,
        primaryDateColumn: dataset.timeContext.anchorDateColumn,
    } : undefined, dataset.relatedTables);
    return raw.error ? result : { ...result, rawData: raw.data };
}

/** Every k-th case, so a sample spans the whole suite rather than its first databases. */
function spread(suite: BenchmarkSuite, count?: number): BenchmarkSuite {
    if (!count || count >= suite.cases.length) return suite;
    const step = suite.cases.length / count;
    const cases = Array.from({ length: count }, (_, i) => suite.cases[Math.floor(i * step)]);
    return { ...suite, cases };
}

export interface AccuracyRunOptions {
    suite: 'business' | 'bird' | 'spider2';
    /** Sample size (spread across the suite). Default: all cases. */
    count?: number;
    /** Only cases whose id matches (e.g. "-m" for the messy-phrasing set). */
    only?: string;
    onCase?: (result: BenchmarkCaseResult, index: number, total: number) => void;
    shouldCancel?: () => boolean;
}

export async function runAISQLAccuracy(options: AccuracyRunOptions): Promise<BenchmarkRun> {
    const source = options.suite === 'business'
        ? BUSINESS_BENCHMARK_SUITE
        : AUDITED_HOLDOUT_BENCHMARK_SUITES.find(suite => suite.id === (options.suite === 'bird' ? 'bird-dev-holdout' : 'spider2-lite-holdout'));
    if (!source) throw new Error(`Unknown suite ${options.suite}`);
    const filtered = options.only ? { ...source, cases: source.cases.filter(testCase => new RegExp(options.only!).test(testCase.id)) } : source;
    const suite = spread(filtered, options.count);
    return runBenchmark([suite], {
        loadDataset: loadResearchBenchmarkDataset,
        reloadDataset: reloadIsolatedBenchmarkData,
        executeGoldSql: async (rows, sql, timeContext, relatedTables) => executeSQLViaDuckDB(rows, sql, timeContext, relatedTables),
        runPipeline: runCurrentAISQL,
    }, {
        scope: 'full',
        privacyMode: 'strict',
        shuffle: false,
        appVersion: 'ai-sql-accuracy',
        shouldCancel: options.shouldCancel,
        onCaseComplete: (result, index, total) => options.onCase?.(result, index, total),
        interCaseDelayMs: 2_500,
        maxLlmAttemptsPerCase: 3,
        llmRetryDelayMs: 8_000,
        stopOnLlmUnavailable: false,
        maxConsecutiveLlmUnavailable: 4,
    });
}

/**
 * Opened with ?qi-accuracy in the address: window.__qiAccuracy.start({ suite })
 * runs in the background; .status() reports progress; .results holds every
 * case. The backend only grants the benchmark budget to signed-in admins.
 */
export function installAccuracyConsole(): void {
    const state: { running: boolean; done: number; total: number; suite?: string; results: BenchmarkCaseResult[]; run?: BenchmarkRun; error?: string; cancel: boolean } = { running: false, done: 0, total: 0, results: [], cancel: false };
    const save = () => { try { localStorage.setItem(`qi-accuracy-${state.suite}`, JSON.stringify(state.results)); } catch { /* storage full or blocked */ } };
    (window as any).__qiAccuracy = {
        state,
        start(options: Omit<AccuracyRunOptions, 'onCase' | 'shouldCancel'>) {
            if (state.running) return 'already running';
            Object.assign(state, { running: true, done: 0, total: 0, suite: `${options.suite}-${options.only || ''}${options.count || 'all'}`, results: [], run: undefined, error: undefined, cancel: false });
            runAISQLAccuracy({
                ...options,
                shouldCancel: () => state.cancel,
                onCase: (result, index, total) => { state.results.push(result); state.done = index + 1; state.total = total; save(); },
            }).then(run => { state.run = run; }).catch(error => { state.error = error instanceof Error ? error.message : String(error); })
                .finally(() => { state.running = false; save(); });
            return 'started';
        },
        stop() { state.cancel = true; return 'stopping after the current case'; },
        status() {
            const passed = state.results.filter(r => r.passed).length;
            const counts: Record<string, number> = {};
            for (const r of state.results) counts[r.status] = (counts[r.status] || 0) + 1;
            return { running: state.running, suite: state.suite, done: state.done, total: state.total, passed, counts, error: state.error };
        },
        /** Compact rows for review: question, status, both SQLs, both answers (first rows). */
        summary(from = 0, to = 999) {
            return state.results.slice(from, to).map(r => ({
                id: r.caseId, q: r.question, status: r.status, pass: r.passed, why: r.failureReason || r.comparison?.reason,
                gold: r.goldSql, sql: r.candidateSql, expected: r.expectedRows?.slice(0, 6), actual: r.actualRows?.slice(0, 6), tokens: r.tokenUsage?.total,
            }));
        },
    };
}
