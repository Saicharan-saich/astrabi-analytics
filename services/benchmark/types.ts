import type { Dataset } from '../../types';

export type BenchmarkSuiteId = 'spider-compatible' | 'bird-compatible' | 'spider2-compatible';

export type BenchmarkDifficulty = 'easy' | 'medium' | 'hard';

export type BenchmarkCaseStatus =
  | 'pass'
  | 'wrong_result'
  | 'withheld'
  | 'invalid_sql'
  | 'execution_error'
  | 'fixture_error';

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
  category: string;
  difficulty: BenchmarkDifficulty;
  dataset: Dataset;
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
  provenance?: { strategy: string; model?: string; summary?: string };
  tokenUsage?: { prompt: number; completion: number; total: number };
  repairAttempts?: number;
}

export interface BenchmarkCaseResult {
  caseId: string;
  suiteId: BenchmarkSuiteId;
  question: string;
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
  confidence?: number;
  repairAttempts: number;
  tokenUsage: { prompt: number; completion: number; total: number };
}

export interface BenchmarkRunMetrics {
  total: number;
  completed: number;
  passed: number;
  executionAccuracy: number;
  validSqlRate: number;
  safeAnswerRate: number;
  averageConfidence: number;
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
  startedAt: number;
  completedAt?: number;
  cancelled: boolean;
  appVersion: string;
  methodologyLabel: 'Curated Subset Execution Accuracy';
  results: BenchmarkCaseResult[];
  metrics: BenchmarkRunMetrics;
}

export interface BenchmarkRunnerDependencies {
  reloadDataset: (rows: Record<string, unknown>[]) => Promise<void>;
  executeGoldSql: (
    rows: Record<string, unknown>[],
    sql: string,
    timeContext?: { minDate: string; maxDate: string; primaryDateColumn?: string }
  ) => Promise<{ data: Record<string, unknown>[]; error?: string }>;
  runPipeline: (question: string, dataset: Dataset) => Promise<BenchmarkPipelineResult>;
  now?: () => number;
}

export interface BenchmarkRunOptions {
  scope: 'smoke' | 'full';
  appVersion: string;
  shouldCancel?: () => boolean;
  onCaseStart?: (testCase: BenchmarkCase, index: number, total: number) => void;
  onCaseComplete?: (result: BenchmarkCaseResult, index: number, total: number) => void;
}
