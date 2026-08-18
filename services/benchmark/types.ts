import type { Dataset } from '../../types';
import type { PrivacyMode } from '../ai-sql/privacyMode';

export type BenchmarkSuiteId =
  | 'spider-compatible'
  | 'bird-compatible'
  | 'spider2-compatible'
  | 'spider-dev-research'
  | 'bird-dev-research';

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard';

export type BenchmarkCaseStatus =
  | 'pass'
  | 'wrong_result'
  | 'withheld'
  | 'invalid_sql'
  | 'llm_unavailable'
  | 'execution_error'
  | 'fixture_error';

/**
 * A human assessment kept alongside, but never substituted for, the frozen
 * gold-result comparison. This makes judgment calls auditable without
 * inflating the automatic execution-accuracy score.
 */
export type BenchmarkAdjudicationVerdict =
  | 'exact_pass'
  | 'semantically_acceptable'
  | 'partial_answer'
  | 'gold_fixture_issue'
  | 'incorrect'
  | 'verification_unavailable';

export interface BenchmarkAdjudication {
  verdict: BenchmarkAdjudicationVerdict;
  note?: string;
  adjudicatedAt: number;
}

export interface BenchmarkAttribution {
  benchmark: string;
  homepage: string;
  license: string;
  notice: string;
}

export interface BenchmarkComparisonOptions {
  orderMatters: boolean;
  strictColumns?: boolean;
  absoluteTolerance?: number;
  relativeTolerance?: number;
}

export interface BenchmarkCase {
  id: string;
  suiteId: BenchmarkSuiteId;
  sourceId: string;
  question: string;
  /** Official benchmark evidence or external knowledge supplied with a question. */
  context?: string | null;
  category: string;
  difficulty: BenchmarkDifficulty;
  /** Embedded fixtures use `dataset`; research packs are fetched lazily via `datasetRef`. */
  dataset?: Dataset;
  datasetRef?: string;
  goldSql: string;
  expectedRows: Record<string, unknown>[];
  comparison: BenchmarkComparisonOptions;
  tags: string[];
}

export interface BenchmarkSuite {
  id: BenchmarkSuiteId;
  name: string;
  shortName: string;
  version: string;
  description: string;
  methodology: string;
  accent: 'violet' | 'cyan' | 'amber';
  evaluationClass?: 'curated-compatibility' | 'official-public-subset';
  attribution: BenchmarkAttribution;
  cases: BenchmarkCase[];
}

export interface BenchmarkComparisonResult {
  equal: boolean;
  reason: string;
  expectedRowCount: number;
  actualRowCount: number;
  columnMapping: Record<string, string>;
  firstMismatch?: {
    expected: Record<string, unknown>;
    actual?: Record<string, unknown>;
  };
}

export interface BenchmarkPipelineResult {
  sql: string;
  rawData: Record<string, unknown>[];
  validation?: { valid: boolean };
  displaySafety?: { allowed: boolean; reasons?: string[] };
  executionTimeMs?: number;
  engine?: string;
  confidence?: { score: number; level: string };
  provenance?: { strategy: string; model?: string; summary?: string; fallbackReason?: string };
  tokenUsage?: { prompt: number; completion: number; total: number };
  repairAttempts?: number;
}

export interface BenchmarkCaseResult {
  caseId: string;
  suiteId: BenchmarkSuiteId;
  sourceId: string;
  question: string;
  context?: string | null;
  category: string;
  difficulty: BenchmarkDifficulty;
  status: BenchmarkCaseStatus;
  passed: boolean;
  safeToDisplay: boolean;
  validSql: boolean;
  startedAt: number;
  completedAt: number;
  latencyMs: number;
  pipelineLatencyMs: number;
  goldSql: string;
  candidateSql: string;
  expectedRows: Record<string, unknown>[];
  actualRows: Record<string, unknown>[];
  comparison?: BenchmarkComparisonResult;
  failureReason?: string;
  engine?: string;
  model?: string;
  strategy?: string;
  fallbackReason?: string;
  confidence?: number;
  repairAttempts: number;
  tokenUsage: { prompt: number; completion: number; total: number };
  /** Optional admin review. Automatic status and `passed` remain unchanged. */
  adjudication?: BenchmarkAdjudication;
}

export interface BenchmarkRunMetrics {
  total: number;
  completed: number;
  passed: number;
  /** Completed cases divided by the locked run manifest. */
  coverageRate: number;
  executionAccuracy: number;
  /** Accuracy only across cases that received a complete LLM-backed response. */
  llmBackedExecutionAccuracy: number;
  validSqlRate: number;
  safeAnswerRate: number;
  /** Provider-backed cases divided by completed cases. */
  providerAvailabilityRate: number;
  /** Successfully executed candidate queries divided by provider-backed cases. */
  executableSqlRate: number;
  /** Answer-contract acceptance divided by provider-backed cases. */
  contractAcceptanceRate: number;
  averageConfidence: number;
  llmBackedCases: number;
  llmBackedRate: number;
  totalTokens: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  failuresByType: Partial<Record<BenchmarkCaseStatus, number>>;
}

export interface BenchmarkRun {
  id: string;
  schemaVersion: 1;
  suiteVersions: Record<string, string>;
  selectedSuiteIds: BenchmarkSuiteId[];
  scope: 'smoke' | 'full';
  /** Privacy mode frozen for every case in this run. */
  privacyMode?: PrivacyMode;
  startedAt: number;
  completedAt?: number;
  cancelled: boolean;
  interruptionReason?: string;
  /** Number of times an interrupted run has been continued in place. */
  resumeCount?: number;
  appVersion: string;
  methodologyLabel:
    | 'Curated Subset Execution Accuracy'
    | 'Official Public Subset Execution Accuracy'
    | 'Mixed-Suite Execution Accuracy';
  results: BenchmarkCaseResult[];
  metrics: BenchmarkRunMetrics;
}

export interface BenchmarkRunnerDependencies {
  loadDataset?: (testCase: BenchmarkCase) => Promise<Dataset>;
  reloadDataset: (rows: Record<string, unknown>[]) => Promise<void>;
  executeGoldSql: (
    rows: Record<string, unknown>[],
    sql: string,
    timeContext?: { minDate: string; maxDate: string; primaryDateColumn?: string },
    relatedTables?: { name: string; rows: Record<string, unknown>[] }[],
  ) => Promise<{ data: Record<string, unknown>[]; error?: string }>;
  runPipeline: (question: string, dataset: Dataset) => Promise<BenchmarkPipelineResult>;
  /** Maximum wait for fixture loading, DuckDB reloads, and gold execution. */
  localStageTimeoutMs?: number;
  /** Maximum wait for the complete production AI SQL pipeline. */
  pipelineTimeoutMs?: number;
  now?: () => number;
}

export interface BenchmarkRunOptions {
  scope: 'smoke' | 'full';
  /** Run-scoped privacy mode used by the production AI SQL pipeline. */
  privacyMode?: PrivacyMode;
  appVersion: string;
  shouldCancel?: () => boolean;
  onCaseStart?: (testCase: BenchmarkCase, index: number, total: number) => void;
  onCaseComplete?: (result: BenchmarkCaseResult, index: number, total: number) => void;
  /** Minimum wall-clock spacing between case starts to respect the AI proxy. */
  minimumCaseIntervalMs?: number;
  /** Stop rather than silently benchmarking local fallbacks during an outage. */
  stopOnLlmUnavailable?: boolean;
  /**
   * Circuit breaker used by long runs. When resilient mode is enabled, pause
   * after this many consecutive provider failures instead of spending the rest
   * of the run on deterministic fallbacks.
   */
  maxConsecutiveLlmUnavailable?: number;
  /** Continue an existing compatible run, retrying its trailing unavailable cases. */
  resumeRun?: BenchmarkRun;
  /** Injectable wait used by tests. */
  wait?: (milliseconds: number) => Promise<void>;
}
