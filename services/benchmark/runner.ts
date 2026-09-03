import {
  compareResultSets,
  compareResultSetsAsUserAnswer,
  compareWithheldResultSets,
} from './comparator';
import { getRunCorpusId, getSuiteCorpus } from './corpus';
import { BenchmarkFixtureIntegrityError } from './researchDatasetLoader';
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
const DEFAULT_LOCAL_STAGE_TIMEOUT_MS = 60_000;
const DEFAULT_PIPELINE_TIMEOUT_MS = 240_000;
const LLM_UNAVAILABLE_PATTERN = /rate.?limit|too many (?:ai )?requests|daily ai (?:quota|limit)|quota exceeded|credits exhausted|permission.?denied|forbidden|guardrail|provider (?:denied|.*unavailable)|model.*not available|service.*(?:down|unavailable)|network|fetch failed|timed?\s*out/i;
const LOCAL_INFRASTRUCTURE_PATTERN = /benchmark (?:dataset load|duckdb reload|gold sql execution) timed out|duckdb-wasm|webassembly|failed to read from a readablestream|wasm engine|worker is not supported/i;

function withStageTimeout<T>(operation: () => Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Benchmark ${stage} timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds.`));
    }, Math.max(1, timeoutMs));

    Promise.resolve()
      .then(operation)
      .then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

function isLocalInfrastructureFailure(result: BenchmarkCaseResult): boolean {
  return result.status === 'execution_error'
    && LOCAL_INFRASTRUCTURE_PATTERN.test(result.failureReason || '');
}

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
  const llmBackedResults = results.filter(isLlmBacked);
  const llmBackedCases = llmBackedResults.length;
  const llmBackedPassed = llmBackedResults.filter(result => result.passed).length;
  const validSql = llmBackedResults.filter(result => result.validSql).length;
  const safe = llmBackedResults.filter(result => result.safeToDisplay).length;
  const executable = llmBackedResults.filter(result =>
    result.status !== 'execution_error' && result.status !== 'fixture_error'
  ).length;
  const confidenceValues = results.map(result => result.confidence).filter((value): value is number => typeof value === 'number');
  const latencies = results.map(result => result.pipelineLatencyMs || result.latencyMs).filter(value => value >= 0);
  const failuresByType = results.reduce<Partial<Record<BenchmarkCaseStatus, number>>>((counts, result) => {
    if (result.status !== 'pass') counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});

  return {
    total,
    completed,
    passed,
    coverageRate: total ? completed / total : 0,
    executionAccuracy: completed ? passed / completed : 0,
    llmBackedExecutionAccuracy: llmBackedCases ? llmBackedPassed / llmBackedCases : 0,
    validSqlRate: llmBackedCases ? validSql / llmBackedCases : 0,
    safeAnswerRate: llmBackedCases ? safe / llmBackedCases : 0,
    providerAvailabilityRate: completed ? llmBackedCases / completed : 0,
    executableSqlRate: llmBackedCases ? executable / llmBackedCases : 0,
    contractAcceptanceRate: llmBackedCases ? safe / llmBackedCases : 0,
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
    referenceResult: testCase.referenceResult,
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
  const localStageTimeoutMs = dependencies.localStageTimeoutMs || DEFAULT_LOCAL_STAGE_TIMEOUT_MS;
  const pipelineTimeoutMs = dependencies.pipelineTimeoutMs || DEFAULT_PIPELINE_TIMEOUT_MS;

  try {
    const dataset = testCase.dataset || (testCase.datasetRef && dependencies.loadDataset
      ? await withStageTimeout(
        () => dependencies.loadDataset!(testCase),
        localStageTimeoutMs,
        'dataset load',
      )
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

    await withStageTimeout(
      () => dependencies.reloadDataset(dataset.rows),
      localStageTimeoutMs,
      'DuckDB reload',
    );
    if (testCase.referenceResult) {
      // Spider 2.0 publishes result files for tasks without released gold SQL.
      // Do not invent executable "gold" from those answers. Dataset bytes are
      // checksum-verified by the production fixture loader before this point.
      if (!testCase.datasetRef || !/^[a-f0-9]{64}$/.test(testCase.datasetSha256 || '')
        || !testCase.referenceResult.alternatives.length
        || testCase.referenceResult.alternatives.some(reference => !/^[a-f0-9]{64}$/.test(reference.sha256) || !reference.rows.length)) {
        return failureResult(testCase, 'fixture_error', 'Published reference or immutable dataset checksum is missing.', startedAt, now());
      }
    } else {
      const goldExecution = await withStageTimeout(
        () => dependencies.executeGoldSql(
          dataset.rows,
          testCase.goldSql,
          dataset.timeContext ? {
            minDate: dataset.timeContext.minDate,
            maxDate: dataset.timeContext.maxDate,
            primaryDateColumn: dataset.timeContext.anchorDateColumn,
          } : undefined,
          dataset.relatedTables,
        ),
        localStageTimeoutMs,
        'gold SQL execution',
      );

      if (goldExecution.error) {
        const completedAt = now();
        return failureResult(testCase, 'fixture_error', `Gold SQL failed: ${goldExecution.error}`, startedAt, completedAt);
      }

      const fixtureComparison = compareResultSets(testCase.expectedRows, goldExecution.data, {
        ...testCase.comparison,
        // Retain the original corpus's order-insensitive gold-integrity check.
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
    }

    // The AI pipeline shares one in-browser DuckDB connection. Reloading here
    // prevents a previous benchmark case from contaminating the next case.
    await withStageTimeout(
      () => dependencies.reloadDataset(dataset.rows),
      localStageTimeoutMs,
      'DuckDB reload',
    );
    const pipelineQuestion = testCase.context
      ? `${testCase.question}\n\nEvidence: ${testCase.context}`
      : testCase.question;
    const pipelineResult = await withStageTimeout(
      () => dependencies.runPipeline(pipelineQuestion, dataset),
      pipelineTimeoutMs,
      'AI SQL pipeline',
    );
    const completedAt = now();
    const safeToDisplay = pipelineResult.displaySafety?.allowed !== false;
    // A pipeline result exists only after DuckDB executed the candidate. Keep
    // legacy plan conformance as a diagnostic (`validSql`), but do not confuse
    // it with SQL syntax/executability when assigning the outcome.
    const validSql = pipelineResult.validation?.valid !== false;
    const executableSql = Boolean(pipelineResult.sql?.trim());
    const comparisonOptions = {
      ...testCase.comparison,
      // A correct result remains correct whether DuckDB returns ascending,
      // descending, or otherwise equivalent row order.
      orderMatters: testCase.referenceResult ? testCase.comparison.orderMatters : false,
    };
    let comparison;
    let matchedReference = testCase.referenceResult?.alternatives[0];
    try {
      if (testCase.referenceResult) {
        // Use only publisher-specified reference projections/alternatives. Do
        // not weaken a held-out result based on the model's own claimed intent.
        comparison = compareResultSets(matchedReference!.rows, pipelineResult.rawData || [], comparisonOptions);
        for (const reference of testCase.referenceResult.alternatives) {
          const checked = compareResultSets(reference.rows, pipelineResult.rawData || [], comparisonOptions);
          if (checked.equal) {
            comparison = checked;
            matchedReference = reference;
            break;
          }
        }
      } else comparison = compareResultSetsAsUserAnswer(
        testCase.expectedRows,
        pipelineResult.rawData || [],
        comparisonOptions,
        pipelineResult.contractValidation?.requestedOutputFields,
        { question: testCase.question, candidateSql: pipelineResult.sql || '' },
      );
    } catch (comparisonError) {
      // Comparator/reporting defects must never erase an already-executed
      // candidate, its rows, model route, or token evidence. Preserve strict
      // result-set scoring as the fail-closed fallback.
      console.error('[Benchmark Runner] Semantic comparator failed; using strict result comparison:', comparisonError);
      comparison = compareResultSets(
        testCase.expectedRows,
        pipelineResult.rawData || [],
        comparisonOptions,
      );
    }
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
      expectedRows: (matchedReference?.rows || testCase.expectedRows).slice(0, EVIDENCE_ROW_LIMIT),
      referenceResult: testCase.referenceResult,
      matchedReferenceSource: comparison.equal ? matchedReference?.source : undefined,
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
    const tokenTotal = pipelineResult.tokenUsage?.total || 0;
    const pipelineWasLlmBacked = pipelineResult.provenance?.strategy !== 'deterministic'
      && tokenTotal > 0;
    if (!pipelineWasLlmBacked) {
      const fallbackReason = pipelineResult.provenance?.fallbackReason || '';
      const unavailable = LLM_UNAVAILABLE_PATTERN.test(fallbackReason);
      // A provider outage is retryable. A local semantic gate or a model SQL
      // candidate rejected by the deterministic contract is not: retrying the
      // identical case only repeats the same logic error and falsely lowers the
      // measured provider-availability rate.
      if (!unavailable) {
        const providerResponded = tokenTotal > 0;
        return {
          ...base,
          confidence: undefined,
          engine: providerResponded ? 'contract-rejected' : 'semantic-gate',
          model: providerResponded ? pipelineResult.provenance?.model : undefined,
          status: 'execution_error',
          passed: false,
          failureReason: providerResponded
            ? `The LLM responded, but its SQL was rejected and the deterministic continuity result is not valid model-backed benchmark evidence${fallbackReason ? `: ${fallbackReason}` : '.'}`
            : `The local semantic pipeline stopped before an LLM SQL response was produced${fallbackReason ? `: ${fallbackReason}` : '.'}`,
        };
      }
      return {
        ...base,
        // Local continuity output can be useful in the product, but it is not
        // evidence of model confidence and must never look like it is.
        confidence: undefined,
        engine: 'provider-unavailable',
        model: undefined,
        status: 'llm_unavailable',
        passed: false,
        failureReason: `LLM unavailable: ${fallbackReason}`,
      };
    }

    if (!executableSql) {
      return { ...base, status: 'invalid_sql', passed: false, failureReason: 'No executable candidate SQL was produced.' };
    }

    // Execution accuracy is determined by the values returned. Safety and SQL
    // validation remain independent diagnostic rates on the same passing case;
    // they must not turn a value-equivalent output into a wrong answer.
    if (comparison.equal) {
      return { ...base, status: 'pass', passed: true };
    }

    if (!safeToDisplay) {
      // A contract warning must not create a false negative when executed
      // evidence is still deterministically equivalent to the frozen answer.
      // This re-check remains deliberately narrower than human adjudication.
      const withheldComparison = testCase.referenceResult ? comparison : compareWithheldResultSets(
        testCase.expectedRows,
        pipelineResult.rawData || [],
        testCase.comparison,
      );
      if (withheldComparison.equal) {
        comparison = withheldComparison;
        return {
          ...base,
          comparison,
          status: 'pass',
          passed: true,
          failureReason: undefined,
        };
      }
      return {
        ...base,
        status: 'withheld',
        passed: false,
        failureReason: pipelineResult.displaySafety?.reasons?.join(' ') || 'The answer contract withheld this result.',
      };
    }
    // A plan-conformance warning is retained in `validSql`, confidence and the
    // report, but SQL that DuckDB already executed is not "invalid SQL".
    return { ...base, status: 'wrong_result', passed: false, failureReason: comparison.reason };
  } catch (error) {
    const completedAt = now();
    const reason = error instanceof Error ? error.message : String(error);
    return failureResult(
      testCase,
      error instanceof BenchmarkFixtureIntegrityError ? 'fixture_error'
        : /Benchmark AI SQL pipeline timed out/i.test(reason) ? 'llm_unavailable' : 'execution_error',
      reason,
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
  while (index > 0 && (
    run.results[index - 1].status === 'llm_unavailable'
    || isLocalInfrastructureFailure(run.results[index - 1])
  )) index -= 1;
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
  const questionLimit = options.scope === 'full' && options.questionLimit
    ? Math.max(1, Math.floor(options.questionLimit))
    : undefined;
  const corpus = getSuiteCorpus(suites);
  if (!sameSuites || !versionsMatch || previous.scope !== options.scope
    || getRunCorpusId(previous) !== corpus.corpusId
    || previous.corpusManifestSha256 !== corpus.corpusManifestSha256
    || previous.questionLimit !== questionLimit
    || (previous.privacyMode || 'strict') !== privacyMode || previous.metrics.total !== total) {
    throw new Error('This benchmark cannot be resumed because its suite manifest, scope, privacy mode, or version has changed. Start a new run instead.');
  }
}

/** Select a reproducible, suite-balanced case set for smoke, custom, and full
 * runs. A custom limit round-robins suites so 200 questions cannot
 * accidentally mean "only the first selected source". */
export function selectBenchmarkCases(
  suites: BenchmarkSuite[],
  scope: BenchmarkRunOptions['scope'],
  questionLimit?: number,
  shuffleSeed?: number,
): BenchmarkCase[] {
  if (scope === 'smoke') return suites.flatMap(suite => suite.cases.slice(0, 5));
  const available = suites.reduce((total, suite) => total + suite.cases.length, 0);
  const limit = questionLimit === undefined
    ? available
    : Math.min(available, Math.max(1, Math.floor(questionLimit)));
  let cases: BenchmarkCase[];
  if (limit >= available) {
    cases = suites.flatMap(suite => suite.cases);
  } else {
    cases = [];
    let caseIndex = 0;
    while (cases.length < limit) {
      let added = false;
      for (const suite of suites) {
        const testCase = suite.cases[caseIndex];
        if (!testCase) continue;
        cases.push(testCase);
        added = true;
        if (cases.length === limit) break;
      }
      if (!added) break;
      caseIndex += 1;
    }
  }

  // Shuffle using a seeded PRNG (xorshift32) so the order is random but
  // reproducible from the stored seed.
  if (shuffleSeed !== undefined) {
    cases = seededShuffle(cases, shuffleSeed);
  }

  return cases;
}

/** Seeded Fisher-Yates shuffle using xorshift32 for reproducibility. */
function seededShuffle<T>(array: T[], seed: number): T[] {
  const result = [...array];
  let s = seed | 0 || 1; // ensure non-zero
  function xorshift32(): number {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000; // [0, 1)
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(xorshift32() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function runBenchmark(
  suites: BenchmarkSuite[],
  dependencies: BenchmarkRunnerDependencies,
  options: BenchmarkRunOptions,
): Promise<BenchmarkRun> {
  const corpus = getSuiteCorpus(suites);
  const questionLimit = options.scope === 'full' && options.questionLimit
    ? Math.max(1, Math.floor(options.questionLimit))
    : undefined;
  const shuffleSeed = options.resumeRun ? options.resumeRun.shuffleSeed : options.shuffle
    ? (Date.now() ^ (Math.random() * 0x7fffffff | 0)) : undefined;
  const selectedCases = selectBenchmarkCases(suites, options.scope, questionLimit, shuffleSeed);
  const evaluationClasses = new Set(suites.map(suite => suite.evaluationClass || 'curated-compatibility'));
  const methodologyLabel: BenchmarkRun['methodologyLabel'] = corpus.corpusId === 'holdout-550'
    ? 'Oracle-Table DuckDB-Adapted Subset Execution Accuracy'
    : evaluationClasses.size > 1
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
    ...corpus,
    suiteVersions: Object.fromEntries(suites.map(suite => [suite.id, suite.version])),
    selectedSuiteIds: suites.map(suite => suite.id),
    scope: options.scope,
    questionLimit,
    privacyMode: options.privacyMode || 'strict',
    ...(shuffleSeed !== undefined ? { shuffleSeed } : {}),
    startedAt: previousRun?.startedAt || Date.now(),
    cancelled: false,
    appVersion: options.appVersion,
    methodologyLabel,
    results: retainedResults,
    metrics: summarizeBenchmarkResults(retainedResults, selectedCases.length),
    resumeCount: previousRun ? (previousRun.resumeCount || 0) + 1 : 0,
  };

  console.info(`[Benchmark Runner] Manifest locked: scope=${options.scope}, privacy=${run.privacyMode}, suites=${suites.length}, cases=${selectedCases.length}${shuffleSeed !== undefined ? `, shuffleSeed=${shuffleSeed}` : ''}, start=${resumeIndex + 1}`);

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
    const maxLlmAttempts = Math.max(1, Math.floor(options.maxLlmAttemptsPerCase || 1));
    const retryDelayMs = Math.max(0, options.llmRetryDelayMs || 0);
    let result = await executeBenchmarkCase(testCase, dependencies);
    for (let attempt = 2; result.status === 'llm_unavailable' && attempt <= maxLlmAttempts; attempt += 1) {
      if (options.shouldCancel?.()) break;
      if (retryDelayMs > 0) {
        const wait = options.wait || ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
        console.info(`[Benchmark Runner] Provider unavailable for ${testCase.id}; retrying attempt ${attempt}/${maxLlmAttempts} after ${retryDelayMs}ms`);
        await wait(retryDelayMs);
      }
      result = await executeBenchmarkCase(testCase, dependencies);
    }
    run.results.push(result);
    run.metrics = summarizeBenchmarkResults(run.results, selectedCases.length);
    options.onCaseComplete?.(result, index, selectedCases.length);

    if (isLocalInfrastructureFailure(result)) {
      run.interruptionReason = `${result.failureReason} The local benchmark engine became unavailable, so the run was paused instead of mis-scoring the remaining questions. Reconnect, then resume from this case.`;
      console.warn(`[Benchmark Runner] Infrastructure pause after ${run.results.length}/${selectedCases.length} cases: ${run.interruptionReason}`);
      break;
    }

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
    const remainingStartSpacing = Math.max(0, minimumInterval - (Date.now() - caseStartedAt));
    const interCaseDelay = Math.max(0, options.interCaseDelayMs || 0);
    const remainingDelay = Math.max(remainingStartSpacing, interCaseDelay);
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
