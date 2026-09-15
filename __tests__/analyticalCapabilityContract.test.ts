import { describe, expect, it } from 'vitest';
import {
  buildAnalyticalCapabilityContract,
  validatePlanAgainstCapabilityContract,
} from '../services/ai-sql/analyticalCapabilityContract';
import type { AnalysisPlan, SemanticField, SemanticModel } from '../services/ai-sql/types';
import type { AnalyticalIR } from '../services/ai-sql/analyticalIR';

const field = (overrides: Partial<SemanticField> & Pick<SemanticField, 'name'>): SemanticField => ({
  name: overrides.name,
  physicalType: 'number',
  semanticType: 'currency',
  role: 'metric',
  defaultAgg: 'sum',
  timeGrainSupport: [],
  synonyms: [],
  valueDescriptors: [],
  distinctCount: 4,
  hasNulls: false,
  displayLabel: overrides.name,
  ...overrides,
});

const model = (fields: SemanticField[], joinGraph?: SemanticModel['joinGraph']): SemanticModel => ({
  fields,
  compositeMetrics: [],
  derivedMetrics: [],
  datasetName: 'trade.xlsx',
  rowCount: 10,
  grain: 'one row per trade line',
  revision: 'rev-1',
  joinGraph,
});

const plan = (metrics: AnalysisPlan['metrics'], dimensions: AnalysisPlan['dimensions'] = []): AnalysisPlan => ({
  intent: dimensions.length ? 'breakdown' : 'single_metric',
  dimensions,
  metrics,
  filters: [],
  sort: [],
  limit: null,
  ambiguous: false,
  resultGrain: dimensions.length ? dimensions.map(item => item.field).join(' × ') : 'one total',
  originalQuestion: 'test question',
});

describe('Analytical Capability Contract', () => {
  it('allows SUM only for a governed additive measure', () => {
    const contract = buildAnalyticalCapabilityContract(model([
      field({ name: 'sales', additivity: 'additive' }),
    ]));
    const validation = validatePlanAgainstCapabilityContract(plan([{ field: 'sales', agg: 'sum' }]), contract);
    expect(validation.status).toBe('safe');
    expect(validation.checks.find(check => check.id === 'aggregation:sales:sum')?.status).toBe('pass');
  });

  it('blocks SUM on percentages and identifiers even when they are numeric', () => {
    const contract = buildAnalyticalCapabilityContract(model([
      field({ name: 'margin_pct', semanticType: 'percentage', additivity: 'non_additive' }),
      field({ name: 'trade_id', semanticType: 'identifier', role: 'dimension', keyRole: 'primary_key', additivity: 'not_applicable' }),
    ]));
    const percentage = validatePlanAgainstCapabilityContract(plan([{ field: 'margin_pct', agg: 'sum' }]), contract);
    const identifier = validatePlanAgainstCapabilityContract(plan([{ field: 'trade_id', agg: 'sum' }]), contract);
    expect(percentage.status).toBe('blocked');
    expect(identifier.status).toBe('blocked');
  });

  it('allows AVG but not SUM for numeric descriptive dimensions such as age', () => {
    const contract = buildAnalyticalCapabilityContract(model([
      field({ name: 'age', semanticType: 'ordinal', role: 'dimension', defaultAgg: 'avg' }),
    ]));
    expect(validatePlanAgainstCapabilityContract(plan([{ field: 'age', agg: 'avg' }]), contract).status).toBe('safe');
    expect(validatePlanAgainstCapabilityContract(plan([{ field: 'age', agg: 'sum' }]), contract).status).toBe('blocked');
  });

  it('supports COUNT(*) without inventing a governed physical field', () => {
    const contract = buildAnalyticalCapabilityContract(model([]));
    expect(validatePlanAgainstCapabilityContract(plan([{ field: '*', agg: 'count' }]), contract).status).toBe('safe');
  });

  it('blocks a semi-additive snapshot summed across a time grouping', () => {
    const contract = buildAnalyticalCapabilityContract(model([
      field({ name: 'inventory_balance', additivity: 'semi_additive' }),
      field({
        name: 'period_date', physicalType: 'date', semanticType: 'date', role: 'dimension',
        defaultAgg: 'none', additivity: 'not_applicable', timeGrainSupport: ['month', 'quarter', 'year'],
      }),
    ]));
    const validation = validatePlanAgainstCapabilityContract(
      plan([{ field: 'inventory_balance', agg: 'sum' }], [{ field: 'period_date', timeGrain: 'month' }]),
      contract,
    );
    expect(validation.status).toBe('blocked');
    expect(validation.checks.some(check => check.id === 'time-additivity:inventory_balance' && check.status === 'fail')).toBe(true);
  });

  it('blocks multi-table fan-out before SQL execution', () => {
    const contract = buildAnalyticalCapabilityContract(model([
      field({ name: 'sales', ownerTable: 'fact_sales', additivity: 'additive' }),
      field({ name: 'category', ownerTable: 'dim_category', physicalType: 'string', semanticType: 'category', role: 'dimension', defaultAgg: 'none', additivity: 'not_applicable' }),
    ]));
    const ir = {
      relationships: { tables: ['fact_sales', 'dim_category'], path: [], mode: 'join', fanoutRisk: true },
    } as unknown as AnalyticalIR;
    const validation = validatePlanAgainstCapabilityContract(
      plan([{ field: 'sales', agg: 'sum' }], [{ field: 'category' }]),
      contract,
      ir,
    );
    expect(validation.status).toBe('blocked');
    expect(validation.checks.some(check => check.id === 'relationship:fanout')).toBe(true);
  });

  it('is deterministic and never embeds row values', () => {
    const semanticModel = model([field({ name: 'sales', additivity: 'additive' })]);
    const first = buildAnalyticalCapabilityContract(semanticModel);
    const second = buildAnalyticalCapabilityContract(semanticModel);
    expect(first.contractId).toBe(second.contractId);
    expect(first.privacy.containsRowValues).toBe(false);
  });
});
