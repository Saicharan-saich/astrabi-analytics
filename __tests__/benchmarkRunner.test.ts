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
      engine: 'question-builder',
      confidence: { score: 95, level: 'high' },
      provenance: { strategy: 'deterministic' },
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
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

  it('treats a fail-closed display decision as withheld, not correct', async () => {
    const result = await executeBenchmarkCase(firstCase, dependencies({
      runPipeline: async () => ({
        sql: firstCase.goldSql,
        rawData: firstCase.expectedRows,
        validation: { valid: true },
        displaySafety: { allowed: false, reasons: ['Answer contract failed.'] },
      }),
    }));
    expect(result.status).toBe('withheld');
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain('Answer contract failed');
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
    }), { scope: 'smoke', appVersion: 'test' });

    expect(run.results).toHaveLength(5);
    expect(run.metrics.executionAccuracy).toBe(1);
    expect(run.metrics.totalTokens).toBe(75);
    expect(run.metrics.llmBackedRate).toBe(1);
    expect(run.methodologyLabel).toBe('Curated Subset Execution Accuracy');
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
