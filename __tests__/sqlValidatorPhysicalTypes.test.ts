import { describe, expect, it } from 'vitest';
import { validateSQL } from '../services/ai-sql/sqlValidator';
import type { AnalysisPlan, SemanticModel } from '../services/ai-sql/types';

const model = {
    rowCount: 100,
    fields: [
        { name: 'year', physicalType: 'number', semanticType: 'date', role: 'dimension' },
        { name: 'points', physicalType: 'number', semanticType: 'quantity', role: 'metric' },
    ],
} as unknown as SemanticModel;

const plan = {
    intent: 'single_metric',
    dimensions: [],
    metrics: [{ field: 'year', agg: 'min' }],
    filters: [],
    sort: [],
    limit: null,
    ambiguous: false,
    resultGrain: 'one row',
    originalQuestion: 'What was the first year?',
} as AnalysisPlan;

describe('AI SQL physical type validation', () => {
    it('blocks direct numeric-to-date casts before DuckDB execution', () => {
        const result = validateSQL('SELECT YEAR(MIN(CAST(data.year AS DATE))) AS first_year FROM data', plan, model);
        expect(result.valid).toBe(false);
        expect(result.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Physical date compatibility', status: 'fail' }),
        ]));
    });

    it('allows a numeric year to remain numeric', () => {
        const result = validateSQL('SELECT MIN(data.year) AS first_year FROM data', plan, model);
        expect(result.checks.find(check => check.name === 'Physical date compatibility')?.status).toBe('pass');
    });
});
