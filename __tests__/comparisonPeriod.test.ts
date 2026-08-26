import { describe, expect, it } from 'vitest';
import { previousComparisonPeriod } from '../services/comparisonPeriod';

describe('previousComparisonPeriod', () => {
    it('aligns month-to-date with the same days of the prior month', () => {
        expect(previousComparisonPeriod('2025-03-01', '2025-03-15', 'month')).toEqual({
            start: '2025-02-01',
            end: '2025-02-15',
        });
    });

    it('clamps month-end safely', () => {
        expect(previousComparisonPeriod('2025-03-01', '2025-03-31', 'month')).toEqual({
            start: '2025-02-01',
            end: '2025-02-28',
        });
    });

    it('shifts an explicitly daily comparison by one day', () => {
        expect(previousComparisonPeriod('2025-03-02', '2025-03-15', 'day')).toEqual({
            start: '2025-03-01',
            end: '2025-03-14',
        });
    });

    it('keeps custom rolling windows as adjacent equal-size periods', () => {
        expect(previousComparisonPeriod('2025-03-02', '2025-03-15')).toEqual({
            start: '2025-02-16',
            end: '2025-03-01',
        });
    });
});
