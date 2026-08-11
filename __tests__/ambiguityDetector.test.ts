import { describe, expect, it } from 'vitest';
import { detectAmbiguities } from '../services/ai-sql/ambiguityDetector';
import type { SemanticModel } from '../services/ai-sql/types';

const model: SemanticModel = {
  datasetName: 'Retail',
  rowCount: 10,
  grain: 'one row per order',
  fields: [{
    name: 'profit', displayLabel: 'Profit', physicalType: 'number', semanticType: 'currency',
    role: 'metric', defaultAgg: 'sum', timeGrainSupport: [], synonyms: [], valueDescriptors: [],
    distinctCount: 10, hasNulls: false,
  }],
  compositeMetrics: [],
  derivedMetrics: [],
};

describe('ambiguity detector explicit thresholds', () => {
  it('does not reinterpret a supplied numeric threshold as below-average ambiguity', () => {
    const result = detectAmbiguities('Which categories have total profit below 2000?', model);
    expect(result.ambiguities.some(ambiguity => ambiguity.type === 'threshold')).toBe(false);
  });

  it('continues to detect genuinely relative low-profit language', () => {
    const result = detectAmbiguities('Which products have low profit?', model);
    expect(result.ambiguities.some(ambiguity => ambiguity.type === 'threshold')).toBe(true);
  });
});
