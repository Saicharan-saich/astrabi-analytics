import type { Dataset } from '../../types';
import type { PrivacyMode } from '../ai-sql/privacyMode';

export type BenchmarkSuiteId =
  | 'spider-compatible'
  | 'bird-compatible'
  | 'spider2-compatible'
  | 'spider-dev-research'
  | 'bird-dev-research'
  | 'bird-dev-holdout'
  | 'spider2-lite-holdout';

export type BenchmarkCorpusId = 'legacy-550' | 'holdout-550';

export interface PublishedBenchmarkReference {
  kind: 'published-result';
  sourceCommit: string;
  alternatives: Array<{
    source: string;
    sha256: string;
    rows: Record<string, unknown>[];
    conditionColumns: number[];
  }>;
}

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard';

export type BenchmarkOracleQuality =
  | 'no_issue_found'
  | 'confirmed_defect'
  | 'review_required'
  | 'not_fully_verifiable';

export type BenchmarkCaseStatus =
  | 'pass'
  | 'wrong_result'
  | 'withheld'
  | 'invalid_sql'
  | 'llm_unavailable'
  | 'clarification_required'
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
  /** SHA-256 of the complete decompressed JSON fixture bytes, verified before loading. */
  datasetSha256?: string;
  /** Some genuine Spider 2.0 cases publish results but no reference SQL. */
  referenceResult?: PublishedBenchmarkReference;
  goldSql: string;
  expectedRows: Record<string, unknown>[];
  comparison: BenchmarkComparisonOptions;
  tags: string[];
  /** Independent corpus-quality audit. Cases that are not no_issue_found are
   * quarantined before run selection and cannot affect model accuracy. */
  oracleQuality?: BenchmarkOracleQuality;
  oracleQualityNote?: string;
}

export interface BenchmarkSuite {
  id: BenchmarkSuiteId;
  name: string;
  shortName: string;
  version: string;
  corpusId?: BenchmarkCorpusId;
  manifestSha256?: string;
  /** Original frozen source manifest when manifestSha256 also incorporates a
   * later oracle-quality audit. */
  sourceManifestSha256?: string;
  oracleAuditSha256?: string;
  sourceCaseCount?: number;
  quarantinedCaseCount?: number;
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
  /** Deterministic rule that established equivalence. Useful when a safety
   * gate withheld an answer whose executed values still satisfy the gold
   * answer contract. */
  equivalenceRule?: 'exact_result_set' | 'requested_projection' | 'verified_helper_projection' | 'neutral_extra_rows';
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
  /** Physical result fields independently grounded from the user's requested
   * answer. Benchmark comparison uses these to distinguish a missing answer
   * from a deliberately omitted helper aggregate used only by HAVING/ORDER BY. */
  contractValidation?: {
    requestedOutputFields?: string[];
  };
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
  referenceResult?: PublishedBenchmarkReference;
  matchedReferenceSource?: string;
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
  /** Absent in legacy reports, which belong to the original 550-case corpus. */
  corpusId?: BenchmarkCorpusId;
  corpusManifestSha256?: string;
  suiteVersions: Record<string, string>;
  selectedSuiteIds: BenchmarkSuiteId[];
  scope: 'smoke' | 'full';
  /** Optional deterministic cap used by an administrator-selected custom run.
   * Omitted for legacy smoke/full runs. */
  questionLimit?: number;
  /** Privacy mode frozen for every case in this run. */
  privacyMode?: PrivacyMode;
  /** Seed used to shuffle the question order. Omitted when shuffle is off. */
  shuffleSeed?: number;
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
    | 'Oracle-Table DuckDB-Adapted Subset Execution Accuracy'
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
  /** Run at most this many cases, distributed deterministically across the
   * selected suites. Only applies to full-scope/custom runs. */
  questionLimit?: number;
  /** Run-scoped privacy mode used by the production AI SQL pipeline. */
  privacyMode?: PrivacyMode;
  /** Shuffle the question order so each run uses a different random sequence.
   * A numeric seed is generated automatically and stored on the run for
   * reproducibility. */
  shuffle?: boolean;
  appVersion: string;
  shouldCancel?: () => boolean;
  onCaseStart?: (testCase: BenchmarkCase, index: number, total: number) => void;
  onCaseComplete?: (result: BenchmarkCaseResult, index: number, total: number) => void;
  /** Minimum wall-clock spacing between case starts to respect the AI proxy. */
  minimumCaseIntervalMs?: number;
  /** Cooldown after a completed case and before the next provider request. */
  interCaseDelayMs?: number;
  /** Maximum provider attempts for one case. Only unavailable attempts retry. */
  maxLlmAttemptsPerCase?: number;
  /** Delay before retrying an unavailable provider response. */
  llmRetryDelayMs?: number;
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
