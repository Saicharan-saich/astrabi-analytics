import { describe, expect, it } from 'vitest';
import { validateAnswerContract } from '../services/ai-sql/answerContractValidator';

const model: any = {
  fields: [
    { name: 'sales', role: 'metric', semanticType: 'currency' },
    { name: 'CountryName', role: 'dimension', semanticType: 'category' },
  ],
  compositeMetrics: [], derivedMetrics: [], datasetName: 'data', rowCount: 15, grain: 'record',
};

const plan: any = {
  intent: 'single_metric', dimensions: [], metrics: [{ field: 'sales', agg: 'sum' }],
  filters: [], sort: [], limit: null, ambiguous: false, resultGrain: 'one row per record', originalQuestion: '',
};

describe('answer contract validation', () => {
  it('uses the final AI query contract instead of a fragmented local draft', () => {
    const result = validateAnswerContract(
      plan,
      'SELECT CountryName FROM countries',
      [{ CountryName: 'germany' }, { CountryName: 'france' }],
      'table',
      'missing_chart_key',
      'another_missing_chart_key',
      model,
      undefined,
      { expectedResult: { grain: 'one row per country', columns: ['CountryName'] } },
    );

    expect(result.passed).toBe(true);
    expect(result.checks.find(check => check.id === 'metrics_present')?.status).toBe('pass');
    expect(result.checks.find(check => check.id === 'chart_matches_data')?.status).toBe('warn');
  });
});
