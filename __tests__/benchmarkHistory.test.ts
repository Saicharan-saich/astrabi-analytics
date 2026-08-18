import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearBenchmarkRun,
  loadBenchmarkRun,
  loadBenchmarkRunHistory,
  saveBenchmarkRun,
} from '../services/benchmark/storage';
import type { BenchmarkRun } from '../services/benchmark/types';

function runFixture(): BenchmarkRun {
  return {
    id: 'history-run-1',
    schemaVersion: 1,
    suiteVersions: { 'spider-dev-research': '1.0' },
    selectedSuiteIds: ['spider-dev-research'],
    scope: 'smoke',
    privacyMode: 'strict',
    startedAt: 100,
    completedAt: 200,
    cancelled: false,
    appVersion: '3.0',
    methodologyLabel: 'Official Public Subset Execution Accuracy',
    results: [],
    metrics: {
      total: 0, completed: 0, passed: 0, coverageRate: 0, executionAccuracy: 0,
      llmBackedExecutionAccuracy: 0, validSqlRate: 0, safeAnswerRate: 0,
      providerAvailabilityRate: 0, executableSqlRate: 0, contractAcceptanceRate: 0,
      averageConfidence: 0, llmBackedCases: 0, llmBackedRate: 0, totalTokens: 0,
      medianLatencyMs: 0, p95LatencyMs: 0, failuresByType: {},
    },
  };
}

describe('benchmark history storage fallback', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('indexedDB', undefined);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it('preserves the latest run synchronously and exposes it as history when IndexedDB is unavailable', async () => {
    const run = runFixture();
    expect(saveBenchmarkRun(run)).toBe(true);
    expect(loadBenchmarkRun()?.id).toBe(run.id);
    await expect(loadBenchmarkRunHistory()).resolves.toEqual([run]);
  });

  it('clears only the legacy latest-run pointer', () => {
    saveBenchmarkRun(runFixture());
    clearBenchmarkRun();
    expect(loadBenchmarkRun()).toBeNull();
  });
});
