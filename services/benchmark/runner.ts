import { compareResultSets } from './comparator';
import type {
  BenchmarkCase,
  BenchmarkCaseResult,
  BenchmarkCaseStatus,
  BenchmarkRun,
  BenchmarkRunMetrics,
  BenchmarkRunOptions,
  BenchmarkRunnerDependencies,
  BenchmarkSuite,
} from './types';

const EMPTY_TOKENS = { prompt: 0, completion: 0, total: 0 };
const EVIDENCE_ROW_LIMIT = 50;
const LLM_UNAVAILABLE_PATTERN = /rate.?limit|too many (?:ai )?requests|daily ai quota|credits exhausted|service.*(?:down|unavailable)|network|fetch failed|timed?\s*out/i;

function isLlmBacked(result: BenchmarkCaseResult): boolean {
  return result.strategy !== 'deterministic' && result.tokenUsage.total > 0;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.min(ordered.length - 1, Math.max(0, Math.ceil(fraction * ordered.length) - 1));
  return ordered[index];
}

export function summarizeBenchmarkResults(results: BenchmarkCaseResult[], total = results.length): BenchmarkRunMetrics {
  const completed = results.length;
  const passed = results.filter(result => result.passed).length;
  const validSql = results.filter(result => result.validSql).length;
  const safe = results.filter(result => result.safeToDisplay).length;
  const confidenceValues = results.map(result => result.confidence).filter((value): value is number => typeof value === 'number');
  const llmBackedCases = results.filter(isLlmBacked).length;
  const latencies = results.map(result => result.pipelineLatencyMs || result.latencyMs).filter(value => value >= 0);
  const failuresByType = results.reduce<Partial<Record<BenchmarkCaseStatus, number>>>((counts, result) => {
    if (result.status !== 'pass') counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});

  return {
    total,
    completed,
    passed,
    executionAccuracy: completed ? passed / completed : 0,
    validSqlRate: completed ? validSql / completed : 0,
    safeAnswerRate: completed ? safe / completed : 0,
    averageConfidence: confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
      : 0,
    llmBackedCases,
    llmBackedRate: completed ? llmBackedCases / completed : 0,
    totalTokens: results.reduce((sum, result) => sum + result.tokenUsage.total, 0),
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    failuresByType,
  };
}

function failureResult(
  testCase: BenchmarkCase,
  status: BenchmarkCaseStatus,
  reason: string,
  startedAt: number,
  completedAt: number,
  overrides: Partial<BenchmarkCaseResult> = {},
): BenchmarkCaseResult {
  return {
    caseId: testCase.id,
    suiteId: testCase.suiteId,
    question: testCase.question,
    category: testCase.category,
    difficulty: testCase.difficulty,
    status,
    passed: false,
    safeToDisplay: false,
    validSql: false,
    startedAt,
    completedAt,
    latencyMs: Math.max(0, completedAt - startedAt),
    pipelineLatencyMs: 0,
    goldSql: testCase.goldSql,
    candidateSql: '',
    expectedRows: testCase.expectedRows.slice(0, EVIDENCE_ROW_LIMIT),
    actualRows: [],
    failureReason: reason,
    repairAttempts: 0,
    tokenUsage: { ...EMPTY_TOKENS },
    ...overrides,
  };
}

export async function executeBenchmarkCase(
  testCase: BenchmarkCase,
  dependencies: BenchmarkRunnerDependencies,
): Promise<BenchmarkCaseResult> {
  const now = dependencies.now || Date.now;
  const startedAt = now();

  try {
    await dependencies.reloadDataset(testCase.dataset.rows);
    const goldExecution = await dependencies.executeGoldSql(
      testCase.dataset.rows,
      testCase.goldSql,
      testCase.dataset.timeContext ? {
        minDate: testCase.dataset.timeContext.minDate,
        maxDate: testCase.dataset.timeContext.maxDate,
        primaryDateColumn: testCase.dataset.timeContext.anchorDateColumn,
      } : undefined,
    );

    if (goldExecution.error) {
      const completedAt = now();
      return failureResult(testCase, 'fixture_error', `Gold SQL failed: ${goldExecution.error}`, startedAt, completedAt);
    }

    const fixtureComparison = compareResultSets(testCase.expectedRows, goldExecution.data, {
      ...testCase.comparison,
      strictColumns: true,
    });
    if (!fixtureComparison.equal) {
      const completedAt = now();
      return failureResult(
        testCase,
        'fixture_error',
        `Frozen gold output does not match gold SQL: ${fixtureComparison.reason}`,
        startedAt,
        completedAt,
        { comparison: fixtureComparison, actualRows: goldExecution.data.slice(0, EVIDENCE_ROW_LIMIT) },
      );
    }

    // The AI pipeline shares one in-browser DuckDB connection. Reloading here
    // prevents a previous benchmark case from contaminating the next case.
    await dependencies.reloadDataset(testCase.dataset.rows);
    const pipelineResult = await dependencies.runPipeline(testCase.question, testCase.dataset);
    const completedAt = now();
    const safeToDisplay = pipelineResult.displaySafety?.allowed !== false;
    const validSql = pipelineResult.validation?.valid !== false;
    const comparison = compareResultSets(testCase.expectedRows, pipelineResult.rawData || [], testCase.comparison);
    const base: Omit<BenchmarkCaseResult, 'status' | 'passed' | 'failureReason'> = {
      caseId: testCase.id,
      suiteId: testCase.suiteId,
      question: testCase.question,
      category: testCase.category,
      difficulty: testCase.difficulty,
      safeToDisplay,
      validSql,
      startedAt,
      completedAt,
      latencyMs: Math.max(0, completedAt - startedAt),
      pipelineLatencyMs: pipelineResult.executionTimeMs || 0,
      goldSql: testCase.goldSql,
      candidateSql: pipelineResult.sql || '',
      expectedRows: testCase.expectedRows.slice(0, EVIDENCE_ROW_LIMIT),
      actualRows: (pipelineResult.rawData || []).slice(0, EVIDENCE_ROW_LIMIT),
      comparison,
      engine: pipelineResult.engine,
      model: pipelineResult.provenance?.model,
      strategy: pipelineResult.provenance?.strategy,
      fallbackReason: pipelineResult.provenance?.fallbackReason,
      confidence: pipelineResult.confidence?.score,
      repairAttempts: pipelineResult.repairAttempts || 0,
      tokenUsage: pipelineResult.tokenUsage || { ...EMPTY_TOKENS },
    };

    if (
      pipelineResult.provenance?.strategy === 'deterministic'
      && LLM_UNAVAILABLE_PATTERN.test(pipelineResult.provenance?.fallbackReason || '')
    ) {
      return {
        ...base,
        status: 'llm_unavailable',
        passed: false,
        failureReason: `LLM unavailable: ${pipelineResult.provenance?.fallbackReason}`,
      };
    }

    if (!safeToDisplay) {
      return {
        ...base,
        status: 'withheld',
        passed: false,
        failureReason: pipelineResult.displaySafety?.reasons?.join(' ') || 'The answer contract withheld this result.',
      };
    }
    if (!validSql) {
      return { ...base, status: 'invalid_sql', passed: false, failureReason: 'The generated SQL did not pass validation.' };
    }
    if (!comparison.equal) {
      return { ...base, status: 'wrong_result', passed: false, failureReason: comparison.reason };
    }
    return { ...base, status: 'pass', passed: true };
  } catch (error) {
    const completedAt = now();
    return failureResult(
      testCase,
      'execution_error',
      error instanceof Error ? error.message : String(error),
      startedAt,
      completedAt,
    );
  }
}

export async function runBenchmark(
  suites: BenchmarkSuite[],
  dependencies: BenchmarkRunnerDependencies,
  options: BenchmarkRunOptions,
): Promise<BenchmarkRun> {
  const selectedCases = suites.flatMap(suite => options.scope === 'smoke' ? suite.cases.slice(0, 5) : suite.cases);
  const run: BenchmarkRun = {
    id: `benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    schemaVersion: 1,
    suiteVersions: Object.fromEntries(suites.map(suite => [suite.id, suite.version])),
    selectedSuiteIds: suites.map(suite => suite.id),
    scope: options.scope,
    startedAt: Date.now(),
    cancelled: false,
    appVersion: options.appVersion,
    methodologyLabel: 'Curated Subset Execution Accuracy',
    results: [],
    metrics: summarizeBenchmarkResults([], selectedCases.length),
  };

  for (let index = 0; index < selectedCases.length; index += 1) {
    if (options.shouldCancel?.()) {
      run.cancelled = true;
      break;
    }
    const testCase = selectedCases[index];
    const caseStartedAt = Date.now();
    options.onCaseStart?.(testCase, index, selectedCases.length);
    const result = await executeBenchmarkCase(testCase, dependencies);
    run.results.push(result);
    run.metrics = summarizeBenchmarkResults(run.results, selectedCases.length);
    options.onCaseComplete?.(result, index, selectedCases.length);

    if (result.status === 'llm_unavailable' && options.stopOnLlmUnavailable !== false) {
      run.interruptionReason = result.failureReason || 'The LLM became unavailable during the benchmark.';
      break;
    }

    const minimumInterval = Math.max(0, options.minimumCaseIntervalMs || 0);
    const remainingDelay = minimumInterval - (Date.now() - caseStartedAt);
    if (remainingDelay > 0 && index < selectedCases.length - 1) {
      const wait = options.wait || ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
      await wait(remainingDelay);
    }
  }

  run.completedAt = Date.now();
  run.metrics = summarizeBenchmarkResults(run.results, selectedCases.length);
  return run;
}
