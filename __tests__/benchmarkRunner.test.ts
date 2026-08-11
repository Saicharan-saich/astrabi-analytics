import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_SUITES,
  executeBenchmarkCase,
  runBenchmark,
  summarizeBenchmarkResults,
  type BenchmarkRunnerDependencies,
} from '../services/benchmark';

const firstCase = BENCHMARK_SUITES[0].cases[0];

function dependencies(overrides: Partial<BenchmarkRunnerDependencies> = {}): BenchmarkRunnerDependencies {
  return {
    reloadDataset: async () => undefined,
    executeGoldSql: async () => ({ data: firstCase.expectedRows }),
    runPipeline: async () => ({
      sql: firstCase.goldSql,
      rawData: firstCase.expectedRows,
      validation: { valid: true },
      displaySafety: { allowed: true },
      executionTimeMs: 12,
      engine: 'llm-sql',
      confidence: { score: 95, level: 'high' },
      provenance: { strategy: 'hybrid-plan-llm-sql', model: 'test-terra → test-luna → test-sol' },
      tokenUsage: { prompt: 10, completion: 5, total: 15 },
      repairAttempts: 0,
    }),
    ...overrides,
  };
}

describe('benchmark runner', () => {
  it('verifies gold integrity before scoring a passing candidate', async () => {
    let reloads = 0;
    const result = await executeBenchmarkCase(firstCase, dependencies({
      reloadDataset: async () => { reloads += 1; },
    }));
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(true);
    expect(reloads).toBe(2);
  });

  it('records a fixture failure and does not run AI SQL when frozen gold diverges', async () => {
    let pipelineCalls = 0;
    const result = await executeBenchmarkCase(firstCase, dependencies({
      executeGoldSql: async () => ({ data: [{ definitely_wrong: 1 }] }),
      runPipeline: async () => {
        pipelineCalls += 1;
        throw new Error('must not run');
      },
    }));
    expect(result.status).toBe('fixture_error');
    expect(pipelineCalls).toBe(0);
  });

  it('scores matching values as correct while preserving a safety diagnostic', async () => {
    const result = await executeBenchmarkCase(firstCase, dependencies({
      runPipeline: async () => ({
        sql: firstCase.goldSql,
        rawData: firstCase.expectedRows,
        validation: { valid: true },
        displaySafety: { allowed: false, reasons: ['Answer contract failed.'] },
        provenance: { strategy: 'hybrid-plan-llm-sql' },
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      }),
    }));
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.safeToDisplay).toBe(false);
    expect(result.comparison?.equal).toBe(true);
  });

  it('scores matching values as correct while preserving an SQL-validity diagnostic', async () => {
    const result = await executeBenchmarkCase(firstCase, dependencies({
      runPipeline: async () => ({
        sql: firstCase.goldSql,
        rawData: firstCase.expectedRows,
        validation: { valid: false },
        displaySafety: { allowed: true },
        provenance: { strategy: 'hybrid-plan-llm-sql' },
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      }),
    }));
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.validSql).toBe(false);
    expect(result.comparison?.equal).toBe(true);
  });

  it('ignores candidate row ordering even when the fixture describes a ranking', async () => {
    const rankingCase = {
      ...firstCase,
      expectedRows: [{ label: 'A', value: 10 }, { label: 'B', value: 5 }],
      comparison: { ...firstCase.comparison, orderMatters: true },
    };
    const reversed = [...rankingCase.expectedRows].reverse();
    const result = await executeBenchmarkCase(rankingCase, dependencies({
      executeGoldSql: async () => ({ data: rankingCase.expectedRows }),
      runPipeline: async () => ({
        sql: rankingCase.goldSql,
        rawData: reversed,
        validation: { valid: true },
        displaySafety: { allowed: true },
        provenance: { strategy: 'hybrid-plan-llm-sql' },
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      }),
    }));
    expect(result.status).toBe('pass');
    expect(result.passed).toBe(true);
    expect(result.comparison?.reason).toContain('row order ignored');
  });

  it('retains withheld and invalid-SQL failure categories when values are wrong', async () => {
    const withheld = await executeBenchmarkCase(firstCase, dependencies({
      runPipeline: async () => ({
        sql: firstCase.goldSql, rawData: [{ wrong: 999 }], validation: { valid: true },
        displaySafety: { allowed: false, reasons: ['Answer contract failed.'] },
        provenance: { strategy: 'hybrid-plan-llm-sql' }, tokenUsage: { prompt: 10, completion: 5, total: 15 },
      }),
    }));
    const invalid = await executeBenchmarkCase(firstCase, dependencies({
      runPipeline: async () => ({
        sql: firstCase.goldSql, rawData: [{ wrong: 999 }], validation: { valid: false },
        displaySafety: { allowed: true }, provenance: { strategy: 'hybrid-plan-llm-sql' },
        tokenUsage: { prompt: 10, completion: 5, total: 15 },
      }),
    }));
    expect(withheld.status).toBe('withheld');
    expect(invalid.status).toBe('invalid_sql');
  });

  it('runs five cases per selected suite in smoke scope and aggregates metrics', async () => {
    const suite = BENCHMARK_SUITES[0];
    const expectedBySql = new Map(suite.cases.map(testCase => [testCase.goldSql, testCase.expectedRows]));
    const expectedByQuestion = new Map(suite.cases.map(testCase => [testCase.question, testCase]));
    const run = await runBenchmark([suite], dependencies({
      executeGoldSql: async (_rows, sql) => ({ data: expectedBySql.get(sql) || [] }),
      runPipeline: async question => {
        const testCase = expectedByQuestion.get(question)!;
        return {
          sql: testCase.goldSql,
          rawData: testCase.expectedRows,
          validation: { valid: true },
          displaySafety: { allowed: true },
          tokenUsage: { prompt: 10, completion: 5, total: 15 },
        };
      },
    }), { scope: 'smoke', appVersion: 'test', privacyMode: 'enhanced' });

    expect(run.results).toHaveLength(5);
    expect(run.metrics.executionAccuracy).toBe(1);
    expect(run.metrics.totalTokens).toBe(75);
    expect(run.metrics.llmBackedRate).toBe(1);
    expect(run.methodologyLabel).toBe('Curated Subset Execution Accuracy');
    expect(run.privacyMode).toBe('enhanced');
  });

  it('locks all 50 cases from a selected suite in full scope', async () => {
    const suite = BENCHMARK_SUITES[0];
    const expectedBySql = new Map(suite.cases.map(testCase => [testCase.goldSql, testCase.expectedRows]));
    const expectedByQuestion = new Map(suite.cases.map(testCase => [testCase.question, testCase]));
    const run = await runBenchmark([suite], dependencies({
      executeGoldSql: async (_rows, sql) => ({ data: expectedBySql.get(sql) || [] }),
      runPipeline: async question => {
        const testCase = expectedByQuestion.get(question)!;
        return {
          sql: testCase.goldSql,
          rawData: testCase.expectedRows,
          validation: { valid: true },
          displaySafety: { allowed: true },
          provenance: { strategy: 'hybrid-plan-llm-sql', model: 'test-model' },
          tokenUsage: { prompt: 10, completion: 5, total: 15 },
        };
      },
    }), { scope: 'full', appVersion: 'test' });

    expect(run.scope).toBe('full');
    expect(run.metrics.total).toBe(50);
    expect(run.metrics.completed).toBe(50);
    expect(run.results).toHaveLength(50);
  });

  it('continues after an isolated model outage when resilient mode is enabled', async () => {
    const suite = BENCHMARK_SUITES[0];
    const expectedBySql = new Map(suite.cases.map(testCase => [testCase.goldSql, testCase.expectedRows]));
    const expectedByQuestion = new Map(suite.cases.map(testCase => [testCase.question, testCase]));
    let calls = 0;
    const run = await runBenchmark([suite], dependencies({
      executeGoldSql: async (_rows, sql) => ({ data: expectedBySql.get(sql) || [] }),
      runPipeline: async question => {
        calls += 1;
        const testCase = expectedByQuestion.get(question)!;
        if (calls === 2) {
          return {
            sql: '', rawData: [], validation: { valid: false }, displaySafety: { allowed: false },
            provenance: { strategy: 'deterministic', fallbackReason: 'AI model is temporarily rate limited.' },
            tokenUsage: { prompt: 0, completion: 0, total: 0 },
          };
        }
        return {
          sql: testCase.goldSql,
          rawData: testCase.expectedRows,
          validation: { valid: true },
          displaySafety: { allowed: true },
          provenance: { strategy: 'hybrid-plan-llm-sql', model: 'test-model' },
          tokenUsage: { prompt: 10, completion: 5, total: 15 },
        };
      },
    }), { scope: 'smoke', appVersion: 'test', stopOnLlmUnavailable: false });

    expect(run.results).toHaveLength(5);
    expect(run.metrics.completed).toBe(5);
    expect(run.metrics.failuresByType.llm_unavailable).toBe(1);
    expect(run.interruptionReason).toBeUndefined();
  });

  it('halts instead of silently scoring deterministic output after an LLM outage', async () => {
    const suite = BENCHMARK_SUITES[0];
    const expectedBySql = new Map(suite.cases.map(testCase => [testCase.goldSql, testCase.expectedRows]));
    const run = await runBenchmark([suite], dependencies({
      executeGoldSql: async (_rows, sql) => ({ data: expectedBySql.get(sql) || [] }),
      runPipeline: async (_question, dataset) => ({
        sql: 'SELECT 1',
        rawData: dataset.rows,
        validation: { valid: true },
        displaySafety: { allowed: true },
        provenance: {
          strategy: 'deterministic',
          fallbackReason: 'AI model is currently busy (rate limited).',
        },
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
      }),
    }), { scope: 'smoke', appVersion: 'test' });

    expect(run.results).toHaveLength(1);
    expect(run.results[0].status).toBe('llm_unavailable');
    expect(run.metrics.llmBackedRate).toBe(0);
    expect(run.interruptionReason).toContain('rate limited');
  });

  it('halts on any zero-token deterministic continuity result even without a known provider message', async () => {
    const suite = BENCHMARK_SUITES[0];
    const expectedBySql = new Map(suite.cases.map(testCase => [testCase.goldSql, testCase.expectedRows]));
    const run = await runBenchmark([suite], dependencies({
      executeGoldSql: async (_rows, sql) => ({ data: expectedBySql.get(sql) || [] }),
      runPipeline: async () => ({
        sql: 'SELECT 1',
        rawData: [],
        validation: { valid: true },
        displaySafety: { allowed: true },
        provenance: { strategy: 'deterministic' },
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
      }),
    }), { scope: 'smoke', appVersion: 'test' });

    expect(run.results).toHaveLength(1);
    expect(run.results[0].status).toBe('llm_unavailable');
    expect(run.interruptionReason).toContain('LLM-backed execution required');
  });

  it('calculates p50, p95, safety, validity, and failure taxonomy', () => {
    const base = {
      ...({} as any),
      status: 'pass', passed: true, validSql: true, safeToDisplay: true,
      confidence: 80, pipelineLatencyMs: 10, latencyMs: 10,
      tokenUsage: { prompt: 1, completion: 1, total: 2 },
    };
    const metrics = summarizeBenchmarkResults([
      base,
      { ...base, status: 'wrong_result', passed: false, pipelineLatencyMs: 100 },
      { ...base, status: 'invalid_sql', passed: false, validSql: false, safeToDisplay: false, pipelineLatencyMs: 1000 },
    ], 3);
    expect(metrics.executionAccuracy).toBeCloseTo(1 / 3);
    expect(metrics.validSqlRate).toBeCloseTo(2 / 3);
    expect(metrics.safeAnswerRate).toBeCloseTo(2 / 3);
    expect(metrics.medianLatencyMs).toBe(100);
    expect(metrics.p95LatencyMs).toBe(1000);
    expect(metrics.failuresByType.wrong_result).toBe(1);
  });
});
