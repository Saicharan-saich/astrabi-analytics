/**
 * One rule for what kind of number a column holds and how many decimals to
 * show, used by every chart, label and sentence.
 */
import { describe, expect, it } from 'vitest';
import { decimalsFor, isCountName, isRateName } from '../utils/numberKind';
import { formatNumber } from '../utils/chartUtils';
import { formatAverageNumber } from '../utils/averageCheck';
import { listValues } from '../utils/duckdbLists';

describe('rates are matched by whole words', () => {
    it('a count of rated tickets is not a rate', () => {
        for (const name of ['rated_tickets', 'Rated Tickets', 'created_at', 'generated_revenue', 'operated_hours', 'accurate_orders', 'ratedTickets'])
            expect({ name, rate: isRateName(name) }).toEqual({ name, rate: false });
    });
    it('real rates and percentages are', () => {
        for (const name of ['success_rate', 'Conversion Rate', 'churn_pct', 'percent_complete', 'share_of_sales', 'conversion', 'Margin %', 'sla_met_rate_pct', 'returnRate'])
            expect({ name, rate: isRateName(name) }).toEqual({ name, rate: true });
    });
    it('a rate of pay or exchange is not a percentage', () => {
        for (const name of ['hourly_rate', 'Daily Rate', 'exchange_rate', 'billing_rate'])
            expect({ name, rate: isRateName(name) }).toEqual({ name, rate: false });
    });
    it('counts are recognised', () => {
        expect(isCountName('rated_tickets')).toBe(true);
        expect(isCountName('order_count')).toBe(true);
        expect(isCountName('average_csat_score')).toBe(false);
    });
});

describe('decimals', () => {
    it('a value with decimals shows 2 places; a whole number none', () => {
        expect(decimalsFor(4.67)).toBe(2);
        expect(decimalsFor(4.5)).toBe(2);
        expect(decimalsFor(584)).toBe(0);
        expect(decimalsFor(4.67, 1)).toBe(1);
    });
    it('chart numbers: averages keep their decimals, counts stay counts', () => {
        expect(formatNumber(4.6712, undefined, undefined, 'Average csat score')).toBe('4.67');
        expect(formatNumber(4.5, undefined, undefined, 'average_rating')).toBe('4.50');
        expect(formatNumber(584, undefined, undefined, 'rated_tickets')).toBe('584');
        expect(formatNumber(584, undefined, undefined, 'rated_tickets')).not.toContain('%');
        expect(formatNumber(0.42, undefined, undefined, 'success_rate')).toBe('42.00%');
        expect(formatAverageNumber(4.7)).toBe('4.70');
        expect(formatAverageNumber(5)).toBe('5');
    });
});

describe('DuckDB lists', () => {
    it('blank entries stay blank instead of reading leftover bytes', () => {
        // A vector whose raw buffer holds garbage in its blank slot, as Arrow can.
        const buffer = new Float64Array([5, 4, 1.16e302, 5]);
        const valid = [true, true, false, true];
        const vector = { length: 4, get: (i: number) => (valid[i] ? buffer[i] : null), toArray: () => buffer };
        expect(listValues(vector)).toEqual([5, 4, null, 5]);
    });
});
