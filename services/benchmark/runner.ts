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
const LLM_UNAVAILABLE_PATTERN = /rate.?limit|too many (?:ai )?requests|daily ai (?:quota|limit)|quota exceeded|credits exhausted|permission.?denied|forbidden|guardrail|provider denied|model.*not available|service.*(?:down|unavailable)|network|fetch failed|timed?\s*out/i;

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
    sourceId: testCase.sourceId,
    question: testCase.question,
    context: testCase.context,
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
    const dataset = testCase.dataset || (testCase.datasetRef && dependencies.loadDataset
      ? await dependencies.loadDataset(testCase)
      : undefined);
    if (!dataset) {
      const completedAt = now();
      return failureResult(
        testCase,
        'fixture_error',
        testCase.datasetRef
          ? `Research fixture loader is unavailable for ${testCase.datasetRef}.`
          : 'Benchmark case has no dataset fixture.',
        startedAt,
        completedAt,
      );
    }

    await dependencies.reloadDataset(dataset.rows);
    const goldExecution = await dependencies.executeGoldSql(
      dataset.rows,
      testCase.goldSql,
      dataset.timeContext ? {
        minDate: dataset.timeContext.minDate,
        maxDate: dataset.timeContext.maxDate,
        primaryDateColumn: dataset.timeContext.anchorDateColumn,
      } : undefined,
      dataset.relatedTables,
    );

    if (goldExecution.error) {
      const completedAt = now();
      return failureResult(testCase, 'fixture_error', `Gold SQL failed: ${goldExecution.error}`, startedAt, completedAt);
    }

    const fixtureComparison = compareResultSets(testCase.expectedRows, goldExecution.data, {
      ...testCase.comparison,
      // Execution accuracy is value-set equivalence. Presentation order is
      // deliberately excluded from benchmark correctness.
      orderMatters: false,
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
    await dependencies.reloadDataset(dataset.rows);
    const pipelineQuestion = testCase.context
      ? `${testCase.question}\n\nEvidence: ${testCase.context}`
      : testCase.question;
    const pipelineResult = await dependencies.runPipeline(pipelineQuestion, dataset);
    const completedAt = now();
    const safeToDisplay = pipelineResult.displaySafety?.allowed !== false;
    const validSql = pipelineResult.validation?.valid !== false;
    const comparison = compareResultSets(testCase.expectedRows, pipelineResult.rawData || [], {
      ...testCase.comparison,
      // A correct result remains correct whether DuckDB returns ascending,
      // descending, or otherwise equivalent row order.
      orderMatters: false,
    });
    const base: Omit<BenchmarkCaseResult, 'status' | 'passed' | 'failureReason'> = {
      caseId: testCase.id,
      suiteId: testCase.suiteId,
      sourceId: testCase.sourceId,
      question: testCase.question,
      context: testCase.context,
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

    // Accuracy evidence from this lab must be model-backed. Never silently
    // score a deterministic continuity answer as an AI SQL benchmark result,
    // even when the provider error text changes or omits a known keyword.
    const pipelineWasLlmBacked = pipelineResult.provenance?.strategy !== 'deterministic'
      && (pipelineResult.tokenUsage?.total || 0) > 0;
    if (!pipelineWasLlmBacked) {
      const fallbackReason = pipelineResult.provenance?.fallbackReason || '';
      const unavailable = LLM_UNAVAILABLE_PATTERN.test(fallbackReason);
      return {
        ...base,
        // Local continuity output can be useful in the product, but it is not
        // evidence of model confidence and must never look like it is.
        confidence: undefined,
        engine: 'provider-unavailable',
        model: undefined,
        status: 'llm_unavailable',
        passed: false,
        failureReason: unavailable
          ? `LLM unavailable: ${fallbackReason}`
          : `LLM-backed execution required, but this case returned ${pipelineResult.provenance?.strategy || 'unknown provenance'} with ${pipelineResult.tokenUsage?.total || 0} tokens${fallbackReason ? `: ${fallbackReason}` : '.'}`,
      };
    }

    // Execution accuracy is determined by the values returned. Safety and SQL
    // validation remain independent diagnostic rates on the same passing case;
    // they must not turn a value-equivalent output into a wrong answer.
    if (comparison.equal) {
      return { ...base, status: 'pass', passed: true };
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
    return { ...base, status: 'wrong_result', passed: false, failureReason: comparison.reason };
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

/**
 * Resume at the first case in the trailing provider-failure sequence. This
 * preserves every valid result while retrying cases that never reached an LLM.
 */
export function getBenchmarkResumeIndex(run: BenchmarkRun): number {
  let index = run.results.length;
  while (index > 0 && run.results[index - 1].status === 'llm_unavailable') index -= 1;
  return index;
}

function assertCompatibleResume(
  previous: BenchmarkRun,
  suites: BenchmarkSuite[],
  options: BenchmarkRunOptions,
  total: number,
): void {
  const suiteIds = suites.map(suite => suite.id);
  const sameSuites = suiteIds.length === previous.selectedSuiteIds.length
    && suiteIds.every((id, index) => id === previous.selectedSuiteIds[index]);
  const versionsMatch = suites.every(suite => previous.suiteVersions[suite.id] === suite.version);
  const privacyMode = options.privacyMode || 'strict';
  if (!sameSuites || !versionsMatch || previous.scope !== options.scope
    || (previous.privacyMode || 'strict') !== privacyMode || previous.metrics.total !== total) {
    throw new Error('This benchmark cannot be resumed because its suite manifest, scope, privacy mode, or version has changed. Start a new run instead.');
  }
}

export async function runBenchmark(
  suites: BenchmarkSuite[],
  dependencies: BenchmarkRunnerDependencies,
  options: BenchmarkRunOptions,
): Promise<BenchmarkRun> {
  const selectedCases = suites.flatMap(suite => options.scope === 'smoke' ? suite.cases.slice(0, 5) : suite.cases);
  const evaluationClasses = new Set(suites.map(suite => suite.evaluationClass || 'curated-compatibility'));
  const methodologyLabel: BenchmarkRun['methodologyLabel'] = evaluationClasses.size > 1
    ? 'Mixed-Suite Execution Accuracy'
    : evaluationClasses.has('official-public-subset')
      ? 'Official Public Subset Execution Accuracy'
      : 'Curated Subset Execution Accuracy';
  const previousRun = options.resumeRun;
  if (previousRun) assertCompatibleResume(previousRun, suites, options, selectedCases.length);
  const resumeIndex = previousRun ? getBenchmarkResumeIndex(previousRun) : 0;
  const retainedResults = previousRun ? previousRun.results.slice(0, resumeIndex) : [];
  const run: BenchmarkRun = {
    id: `benchmark-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    schemaVersion: 1,
    suiteVersions: Object.fromEntries(suites.map(suite => [suite.id, suite.version])),
    selectedSuiteIds: suites.map(suite => suite.id),
    scope: options.scope,
    privacyMode: options.privacyMode || 'strict',
    startedAt: previousRun?.startedAt || Date.now(),
    cancelled: false,
    appVersion: options.appVersion,
    methodologyLabel,
    results: retainedResults,
    metrics: summarizeBenchmarkResults(retainedResults, selectedCases.length),
    resumeCount: previousRun ? (previousRun.resumeCount || 0) + 1 : 0,
  };

  console.info(`[Benchmark Runner] Manifest locked: scope=${options.scope}, privacy=${run.privacyMode}, suites=${suites.length}, cases=${selectedCases.length}, start=${resumeIndex + 1}`);

  let consecutiveLlmUnavailable = 0;
  for (let index = resumeIndex; index < selectedCases.length; index += 1) {
    if (options.shouldCancel?.()) {
      run.cancelled = true;
      console.info(`[Benchmark Runner] Cancelled after ${run.results.length}/${selectedCases.length} cases`);
      break;
    }
    const testCase = selectedCases[index];
    const caseStartedAt = Date.now();
    options.onCaseStart?.(testCase, index, selectedCases.length);
    const result = await executeBenchmarkCase(testCase, dependencies);
    run.results.push(result);
    run.metrics = summarizeBenchmarkResults(run.results, selectedCases.length);
    options.onCaseComplete?.(result, index, selectedCases.length);

    if (result.status === 'llm_unavailable') {
      consecutiveLlmUnavailable += 1;
      const circuitBreakerLimit = options.stopOnLlmUnavailable !== false
        ? 1
        : Math.max(1, options.maxConsecutiveLlmUnavailable || Number.POSITIVE_INFINITY);
      if (consecutiveLlmUnavailable >= circuitBreakerLimit) {
        const providerReason = result.failureReason || 'The LLM became unavailable during the benchmark.';
        run.interruptionReason = `${providerReason} Automatic pause after ${consecutiveLlmUnavailable} consecutive unavailable cases; resume retries from the first one.`;
        console.warn(`[Benchmark Runner] Interrupted after ${run.results.length}/${selectedCases.length} cases: ${run.interruptionReason}`);
        break;
      }
    } else {
      consecutiveLlmUnavailable = 0;
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
  console.info(`[Benchmark Runner] Completed ${run.metrics.completed}/${run.metrics.total} cases`);
  return run;
}
