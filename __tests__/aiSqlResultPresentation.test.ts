import { describe, expect, it } from 'vitest';
import { isDimensionOnlyResult } from '../services/ai-sql/resultPresentation';
import type { ResultProfile } from '../services/ai-sql/types';

function profile(metricCount: number, dimensionCount: number): ResultProfile {
    return {
        rowCount: 4,
        columnCount: metricCount + dimensionCount,
        metricCount,
        dimensionCount,
        dimensionColumns: dimensionCount ? ['department'] : [],
        metricColumns: metricCount ? ['spending'] : [],
        dimensionCardinality: { department: 4 },
        hasTimeDimension: false,
        metricsScaleMismatch: 1,
        metricSemanticTypes: metricCount ? { spending: 'currency' } : {},
        isPivoted: false,
        isSingleValue: false,
    };
}

describe('AI SQL result presentation', () => {
    const departments = [
        { Department: 'Finance' },
        { Department: 'Sales' },
        { Department: 'Operations' },
        { Department: 'IT' },
    ];

    it('recognises a profiled dimension-only projection', () => {
        expect(isDimensionOnlyResult(profile(0, 1), departments)).toBe(true);
    });

    it('does not replace a measurable result with the answer list', () => {
        expect(isDimensionOnlyResult(profile(1, 1), [
            { Department: 'Finance', spending: 100 },
        ])).toBe(false);
    });

    it('recognises legacy string-only results without a stored profile', () => {
        expect(isDimensionOnlyResult(undefined, departments)).toBe(true);
    });

    it('does not classify empty results as a dimension list', () => {
        expect(isDimensionOnlyResult(undefined, [])).toBe(false);
    });
});
