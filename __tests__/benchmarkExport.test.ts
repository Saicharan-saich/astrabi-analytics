import { describe, expect, it } from 'vitest';
import { benchmarkRunToCsv, benchmarkRunToJson } from '../services/benchmark/export';
import type { BenchmarkRun } from '../services/benchmark/types';

function sampleRun(): BenchmarkRun {
  return {
    id: 'benchmark-test',
    schemaVersion: 1,
    suiteVersions: { 'spider-dev-research': '1.0' },
    selectedSuiteIds: ['spider-dev-research'],
    scope: 'full',
    questionLimit: 200,
    privacyMode: 'enhanced',
    startedAt: Date.UTC(2026, 7, 18, 10, 0, 0),
    completedAt: Date.UTC(2026, 7, 18, 10, 1, 0),
    cancelled: false,
    resumeCount: 1,
    appVersion: '3.0.0',
    methodologyLabel: 'Official Public Subset Execution Accuracy',
    metrics: {
      total: 1, completed: 1, passed: 1, coverageRate: 1, executionAccuracy: 1,
      llmBackedExecutionAccuracy: 1, validSqlRate: 1, safeAnswerRate: 1,
      providerAvailabilityRate: 1, executableSqlRate: 1, contractAcceptanceRate: 1,
      averageConfidence: 95, llmBackedCases: 1, llmBackedRate: 1, totalTokens: 30,
      medianLatencyMs: 100, p95LatencyMs: 100, failuresByType: {},
    },
    results: [{
      caseId: 'spider-1', suiteId: 'spider-dev-research', sourceId: 'spider:1:test',
      question: 'How many courses does each teacher teach?', context: 'Teacher names are required.',
      category: 'Grouped aggregation', difficulty: 'medium', status: 'pass', passed: true,
      safeToDisplay: true, validSql: true, startedAt: Date.UTC(2026, 7, 18, 10, 0, 0),
      completedAt: Date.UTC(2026, 7, 18, 10, 0, 1), latencyMs: 1000, pipelineLatencyMs: 900,
      goldSql: 'SELECT Name, COUNT(*) FROM teacher GROUP BY Name',
      candidateSql: 'SELECT teacher_name, COUNT(*) AS course_count FROM teacher GROUP BY teacher_name',
      expectedRows: [{ Name: 'Anne Walker', count: 2 }],
      actualRows: [{ teacher_name: 'Anne Walker', course_count: 2 }],
      comparison: { equal: true, reason: 'Result sets match.', expectedRowCount: 1, actualRowCount: 1,
        columnMapping: { Name: 'teacher_name', count: 'course_count' } },
      engine: 'llm-sql', model: 'openai/gpt-5.6-sol', strategy: 'three-model', confidence: 95,
      repairAttempts: 0, tokenUsage: { prompt: 10, completion: 20, total: 30 },
    }],
  };
}

describe('benchmark evidence export', () => {
  it('includes both result sets and comparator evidence in JSON', () => {
    const parsed = JSON.parse(benchmarkRunToJson(sampleRun()));
    expect(parsed.results[0].expectedRows).toEqual([{ Name: 'Anne Walker', count: 2 }]);
    expect(parsed.results[0].actualRows).toEqual([{ teacher_name: 'Anne Walker', course_count: 2 }]);
    expect(parsed.results[0].comparison.columnMapping).toEqual({ Name: 'teacher_name', count: 'course_count' });
  });

  it('includes result sets, comparator details and complete snapshots in CSV', () => {
    const csv = benchmarkRunToCsv(sampleRun());
    expect(csv).toContain('frozen_gold_output_json');
    expect(csv).toContain('candidate_output_json');
    expect(csv).toContain('comparison_json');
    expect(csv).toContain('run_metadata_json');
    expect(csv).toContain('question_limit');
    expect(csv).toContain('case_result_json');
    expect(csv).toContain('Anne Walker');
    expect(csv).toContain('course_count');
    expect(csv).toContain('openai/gpt-5.6-sol');
  });

  it('serializes bigint output values instead of failing a download', () => {
    const run = sampleRun();
    run.results[0].actualRows = [{ count: BigInt(9) }];
    expect(benchmarkRunToJson(run)).toContain('"count": "9"');
    expect(benchmarkRunToCsv(run)).toContain('count');
  });
});
