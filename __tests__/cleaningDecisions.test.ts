import { describe, expect, it } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { buildReviewOptions, describeReview, type StepDecision } from '../utils/cleaningReview';
import { averageCaution, groupedAverageMessage } from '../utils/averageCheck';
import { averageCautionForSql } from '../services/ai-sql/leanPipeline';

// 30 ordinary orders and two huge ones.
const raw = Array.from({ length: 32 }, (_, i) => ({
    order_id: `O${i + 1}`,
    city: i % 3 === 0 ? 'Manchester' : i === 4 ? 'Manchestr' : 'London',
    amount: i === 30 ? 48000 : i === 31 ? 52000 : 100 + (i % 10) * 5,
}));

describe('cleaning review — decisions change the data', () => {
    it('flags unusual values with a decision to make, and changes nothing by itself', () => {
        const result = runETLPipeline(raw, 'orders.csv');
        const flag = result.logs.find(log => log.step === 'Outlier Flag');
        expect(flag?.decision).toEqual({ kind: 'outlier', column: 'amount' });
        expect(result.rows.map(row => row.amount)).toContain(48000);
    });

    it('keeps them as correct, removes them, or caps them, as chosen', () => {
        const kept = runETLPipeline(raw, 'orders.csv', undefined, { outlierDecisions: { amount: 'keep' } });
        expect(kept.logs.some(log => log.step === 'Outlier Flag')).toBe(false);
        expect(kept.logs.find(log => log.step === 'Outlier Confirmed')?.revert).toMatchObject({ option: 'outlierDecisions', value: null });
        expect(kept.rows).toHaveLength(32);

        const removed = runETLPipeline(raw, 'orders.csv', undefined, { outlierDecisions: { amount: 'remove' } });
        expect(removed.rows).toHaveLength(30);
        expect(removed.rows.map(row => row.amount)).not.toContain(48000);

        const capped = runETLPipeline(raw, 'orders.csv', undefined, { outlierDecisions: { amount: 'cap' } });
        expect(capped.rows).toHaveLength(32);
        expect(Math.max(...capped.rows.map(row => Number(row.amount)))).toBeLessThan(1000);
    });

    it('merges a likely typo only when asked', () => {
        const flagged = runETLPipeline(raw, 'orders.csv');
        expect(flagged.logs.find(log => log.step === 'Possible Typo Flag')?.decision).toEqual({ kind: 'typo', column: 'city' });
        expect(flagged.rows.some(row => row.city === 'Manchestr')).toBe(true);
        const merged = runETLPipeline(raw, 'orders.csv', undefined, { typoDecisions: { city: 'merge' } });
        expect(merged.rows.some(row => row.city === 'Manchestr')).toBe(false);
        expect(merged.logs.find(log => log.step === 'Typo Merge')).toBeTruthy();
    });

    it('turns the review into one set of options, keeping earlier decisions', () => {
        const decisions: Record<string, StepDecision> = {
            a: { kind: 'undo', revert: { option: 'keepDuplicateRows', value: true, label: 'Keep the copies' } },
            b: { kind: 'outlier', column: 'amount', choice: 'remove' },
            c: { kind: 'undo', revert: { option: 'outlierDecisions', value: { profit: 'cap' }, label: "Review 'sales' again" } },
            d: { kind: 'keep' },
            e: { kind: 'typo', column: 'city', choice: 'merge' },
        };
        const next = buildReviewOptions({ outlierDecisions: { sales: 'keep', profit: 'cap' }, keepTotalRows: true }, decisions);
        expect(next).toEqual({
            keepTotalRows: true,
            keepDuplicateRows: true,
            outlierDecisions: { profit: 'cap', amount: 'remove' },
            typoDecisions: { city: 'merge' },
        });
        const review = describeReview(decisions);
        expect(review.changes).toBe(4);
        expect(review.reviewed).toBe(1);
        expect(review.summary).toContain("Remove rows with unusual 'amount' values");
    });
});

describe('averages that mislead', () => {
    it('warns when one value carries the total, with the median', () => {
        expect(averageCaution([100, 0, 0, 0], 'person')?.message)
            .toBe('The average (25) can mislead here: the 4 people are 100, 0, 0 and 0, so one person makes up 100% of the total. The typical person (median) is 0.');
        expect(averageCaution([25, 26, 24, 25])).toBeNull();
        expect(averageCaution([10, 12])).toBeNull();
    });

    it('names the group where the average misleads', () => {
        const flagged = [{ key: 'North', caution: averageCaution([100, 0, 0, 0])! }];
        expect(groupedAverageMessage('sales', 'region', 2, flagged))
            .toBe('Averages can mislead here: in North, the average sales is 25 but one value makes up 100% of the total; the typical value (median) is 0.');
    });

    it('checks simple AI SQL averages on the rows in the browser', () => {
        const rows = [
            { region: 'N', sales: 100 }, { region: 'N', sales: 0 }, { region: 'N', sales: 0 }, { region: 'N', sales: 0 },
            { region: 'S', sales: 20 }, { region: 'S', sales: 22 }, { region: 'S', sales: 21 },
        ];
        expect(averageCautionForSql('SELECT "region", AVG("sales") AS average_sales FROM "data" GROUP BY 1', rows, ['region'])).toContain('in N, the average sales is 25');
        // A filter means the rows behind the answer differ: no guess.
        expect(averageCautionForSql('SELECT AVG("sales") FROM "data" WHERE "region" = \'N\'', rows)).toBeNull();
    });
});
