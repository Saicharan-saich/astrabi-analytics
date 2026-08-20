import type { BenchmarkRun } from './types';

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

function jsonCell(value: unknown): string {
  return JSON.stringify(value ?? null, jsonReplacer);
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function isoTimestamp(value?: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : '';
}

/** Complete reproducible evidence, including recorded result rows. */
export function benchmarkRunToJson(run: BenchmarkRun): string {
  return JSON.stringify(run, jsonReplacer, 2);
}

/**
 * One case per row, with readable columns plus lossless JSON snapshots. This
 * keeps nested result sets and future evidence fields inside the CSV export.
 */
export function benchmarkRunToCsv(run: BenchmarkRun): string {
  const runMetadata = {
    id: run.id,
    schemaVersion: run.schemaVersion,
    suiteVersions: run.suiteVersions,
    selectedSuiteIds: run.selectedSuiteIds,
    scope: run.scope,
    questionLimit: run.questionLimit,
    privacyMode: run.privacyMode || 'strict',
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    cancelled: run.cancelled,
    interruptionReason: run.interruptionReason,
    resumeCount: run.resumeCount || 0,
    appVersion: run.appVersion,
    methodologyLabel: run.methodologyLabel,
    metrics: run.metrics,
  };

  const headers = [
    'run_id', 'run_schema_version', 'app_version', 'methodology', 'scope', 'question_limit', 'privacy_mode',
    'selected_suites_json', 'suite_versions_json', 'run_started_at', 'run_completed_at',
    'run_cancelled', 'run_interruption_reason', 'run_resume_count', 'run_metrics_json',
    'case_id', 'source_id', 'suite', 'question', 'benchmark_context', 'category', 'difficulty',
    'status', 'passed', 'valid_sql', 'safe_to_display', 'case_started_at', 'case_completed_at',
    'latency_ms', 'pipeline_latency_ms', 'prompt_tokens', 'completion_tokens', 'total_tokens',
    'engine', 'strategy', 'model', 'fallback_reason', 'confidence', 'repairs', 'failure_reason',
    'manual_adjudication', 'adjudication_note', 'adjudicated_at', 'gold_sql', 'candidate_sql',
    'expected_row_count', 'actual_row_count', 'comparison_equal', 'comparison_reason',
    'column_mapping_json', 'first_mismatch_json', 'comparison_json',
    'frozen_gold_output_json', 'candidate_output_json', 'run_metadata_json', 'case_result_json',
  ];

  const rows = run.results.map(result => {
    // Adjudication was added after the original run schema. Keep export
    // backward compatible with older saved runs while including it when set.
    const adjudication = (result as typeof result & {
      adjudication?: { verdict: string; note?: string; adjudicatedAt: number };
    }).adjudication;

    return [
    run.id,
    run.schemaVersion,
    run.appVersion,
    run.methodologyLabel,
    run.scope,
    run.questionLimit,
    run.privacyMode || 'strict',
    jsonCell(run.selectedSuiteIds),
    jsonCell(run.suiteVersions),
    isoTimestamp(run.startedAt),
    isoTimestamp(run.completedAt),
    run.cancelled,
    run.interruptionReason,
    run.resumeCount || 0,
    jsonCell(run.metrics),
    result.caseId,
    result.sourceId,
    result.suiteId,
    result.question,
    result.context,
    result.category,
    result.difficulty,
    result.status,
    result.passed,
    result.validSql,
    result.safeToDisplay,
    isoTimestamp(result.startedAt),
    isoTimestamp(result.completedAt),
    result.latencyMs,
    result.pipelineLatencyMs,
    result.tokenUsage.prompt,
    result.tokenUsage.completion,
    result.tokenUsage.total,
    result.engine,
    result.strategy,
    result.model,
    result.fallbackReason,
    result.confidence,
    result.repairAttempts,
    result.failureReason,
    adjudication?.verdict,
    adjudication?.note,
    isoTimestamp(adjudication?.adjudicatedAt),
    result.goldSql,
    result.candidateSql,
    result.comparison?.expectedRowCount ?? result.expectedRows.length,
    result.comparison?.actualRowCount ?? result.actualRows.length,
    result.comparison?.equal,
    result.comparison?.reason,
    jsonCell(result.comparison?.columnMapping || {}),
    jsonCell(result.comparison?.firstMismatch),
    jsonCell(result.comparison),
    jsonCell(result.expectedRows),
    jsonCell(result.actualRows),
    jsonCell(runMetadata),
    jsonCell(result),
    ];
  });

  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}
