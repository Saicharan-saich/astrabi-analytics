import { describe, expect, it } from 'vitest';
import { buildAnalysisCertificate } from '../services/ai-sql/analysisCertificate';
import { buildAnalyticalCapabilityContract, type CapabilityValidation } from '../services/ai-sql/analyticalCapabilityContract';
import type { AISQLPipelineResult, SemanticModel } from '../services/ai-sql/types';

const contract = buildAnalyticalCapabilityContract({
  fields: [], compositeMetrics: [], derivedMetrics: [], datasetName: 'private.xlsx', rowCount: 2,
  grain: 'one row per transaction', revision: 'r1',
} as SemanticModel);

const result = (overrides: Partial<AISQLPipelineResult> = {}): AISQLPipelineResult => ({
  plan: { intent: 'single_metric', dimensions: [], metrics: [], filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'one total', originalQuestion: 'Total sales' },
  sql: 'SELECT SUM(sales) AS total_sales FROM data',
  validation: { valid: true, checks: [{ name: 'Read only', status: 'pass', message: 'SELECT-only SQL.' }] },
  rawData: [{ total_sales: 10 }], chartData: [{ total_sales: 10 }],
  profile: { rowCount: 1, columnCount: 1, metricCount: 1, dimensionCount: 0, dimensionColumns: [], metricColumns: ['total_sales'], dimensionCardinality: {}, hasTimeDimension: false, metricsScaleMismatch: 1, metricSemanticTypes: {}, isPivoted: false, isSingleValue: true },
  chart: { chartType: 'kpiCard', xKey: '', yKey: 'total_sales', useDualAxis: false, reason: 'single value' },
  confidence: { score: 95, level: 'high', factors: { semanticMatch: 30, filterClarity: 20, aggregationCertainty: 20, planComplexity: 12, repairAttempts: 13 }, reasons: [] },
  explanation: 'Total sales is 10.', columnsUsed: ['sales'], executionTimeMs: 2, repairAttempts: 0,
  engine: 'question-builder', provenance: { strategy: 'deterministic', summary: 'Local.', dataAccess: 'metadata_only' },
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  analyticalValidation: { passed: true, issues: [] },
  contractValidation: { passed: true, checks: [{ name: 'Shape', status: 'pass', message: 'One scalar row.' }], summary: 'Passed.' },
  displaySafety: { allowed: true, reasons: [], recoverySuggestions: [] },
  ...overrides,
});
const validation = (status: CapabilityValidation['status'], checkStatus: 'pass' | 'warn' | 'fail'): CapabilityValidation => ({
  status,
  summary: status,
  checks: [{ id: 'grain', category: 'grain', status: checkStatus, title: 'Grain', detail: 'Grain checked.' }],
});

describe('Analysis Certificate', () => {
  it('certifies a fully checked local answer', () => {
    const certificate = buildAnalysisCertificate({ question: 'Total sales', contract, capabilityValidation: validation('safe', 'pass'), result: result() });
    expect(certificate.status).toBe('certified');
    expect(certificate.execution.locality).toBe('local_duckdb');
    expect(certificate.execution.llmUsed).toBe(false);
    expect(certificate.execution.sqlFingerprint).toMatch(/^fnv1a-/);
  });

  it('marks warnings as conditional and failures as withheld', () => {
    const conditional = buildAnalysisCertificate({ question: 'Total sales', contract, capabilityValidation: validation('review', 'warn'), result: result() });
    const withheld = buildAnalysisCertificate({ question: 'Total sales', contract, capabilityValidation: validation('blocked', 'fail'), result: result({ displaySafety: { allowed: false, reasons: ['blocked'], recoverySuggestions: [] } }) });
    expect(conditional.status).toBe('conditional');
    expect(withheld.status).toBe('withheld');
  });

  it('contains evidence metadata but no source rows', () => {
    const certificate = buildAnalysisCertificate({ question: 'Total sales', contract, capabilityValidation: validation('safe', 'pass'), result: result() });
    expect(JSON.stringify(certificate)).not.toContain('rawData');
    expect(JSON.stringify(certificate)).not.toContain('total_sales":10');
  });
});
