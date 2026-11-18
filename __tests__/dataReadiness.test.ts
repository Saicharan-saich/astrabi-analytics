import { describe, expect, it } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { applyBlankDecisions, profileBlanks } from '../services/blankValues';
import { blankCard, recommendedChoice } from '../utils/blankChoices';
import { buildReadiness } from '../utils/dataReadiness';
import { buildReviewOptions } from '../utils/cleaningReview';
import { getStepGuide } from '../components/etlStepGuide';
import { ColumnType, type BlankProfile, type ETLLog } from '../types';

function orders() {
    const rows: Record<string, any>[] = [];
    for (let i = 0; i < 60; i++) {
        rows.push({
            'Order ID': `ORD-${1000 + i}`,
            'Order Date': i % 15 === 0 ? '' : `2025-0${(i % 9) + 1}-1${i % 9}`,
            Region: i % 10 === 0 ? '' : ['North', 'South', 'East'][i % 3],
            Revenue: 100 + (i % 7) * 10,
            Discount: i % 4 === 0 ? '' : 5 + (i % 3),
        });
    }
    return rows;
}

describe('blank cells', () => {
    it('measures every column with blanks before any choice, with exact numbers', () => {
        const result = runETLPipeline(orders(), 'orders.csv');
        const log = result.logs.find(l => l.step === 'Blank Values')!;
        expect(log).toBeTruthy();
        const discount = log.blanks!.find(p => p.column === 'discount')!;
        expect(discount.kind).toBe('number');
        expect(discount.blanks).toBe(15);
        expect(discount.filled).toBe(45);
        expect(discount.zeros).toBe(0);
        expect(discount.choice).toBe('leave');
        const region = log.blanks!.find(p => p.column === 'region')!;
        expect(region.kind).toBe('category');
        expect(region.blanks).toBe(6);
        expect(region.fillWord).toBe('Unknown');
        // Revenue on the rows with no region: what leaving them out would lose.
        expect(region.onBlankRows?.[0].column).toBe('revenue');
        expect(region.onBlankRows?.[0].amount).toBeGreaterThan(0);
    });

    it('applies each choice on a re-clean, and the measurement stays the same', () => {
        const zero = runETLPipeline(orders(), 'orders.csv', undefined, { blankDecisions: { discount: 'zero' } });
        expect(zero.rows.filter(r => r.discount === null || r.discount === undefined).length).toBe(0);
        expect(zero.rows.filter(r => r.discount === 0).length).toBe(15);
        expect(zero.logs.find(l => l.step === 'Blank Values')!.blanks!.find(p => p.column === 'discount')!.blanks).toBe(15);
        const decided = zero.logs.find(l => l.step === 'Blanks Decision')!;
        expect(decided.revert?.option).toBe('blankDecisions');
        expect(decided.revert?.value).toBeNull();

        const removed = runETLPipeline(orders(), 'orders.csv', undefined, { blankDecisions: { region: 'remove' } });
        expect(removed.rows.length).toBe(54);
        expect(removed.rows.some(r => r.region === 'Unknown')).toBe(false);
        const log = removed.logs.find(l => l.step === 'Blanks Decision')!;
        expect(log.removedAmounts?.revenue).toBeGreaterThan(0);
    });

    it('offers the right choices with the numbers each gives', () => {
        const profile: BlankProfile = { column: 'csat_score', kind: 'number', blanks: 2, rows: 10, filled: 8, sum: 32, median: 4, zeros: 0, choice: 'leave' };
        const card = blankCard(profile);
        expect(card.headline).toBe("2 of 10 rows have no 'csat score' (20%)");
        const by = Object.fromEntries(card.options.map(o => [o.choice, o]));
        expect(by.leave.result).toBe('Total 32 · average 4');
        expect(by.zero.result).toBe('Total 32 · average 3.20');
        expect(by.typical.result).toBe('Total 40 · average 4');
        expect(by.remove.result).toBe('8 rows left');
        expect(by.leave.recommended).toBe(true);
        expect(by.typical.effect).toMatch(/never recorded/);
    });

    it('recommends counting as 0 only for optional amounts that never record a 0', () => {
        const base: BlankProfile = { column: 'discount', kind: 'number', blanks: 3, rows: 10, filled: 7, sum: 35, median: 5, zeros: 0, choice: 'leave' };
        expect(recommendedChoice(base).choice).toBe('zero');
        expect(recommendedChoice({ ...base, zeros: 2 }).choice).toBe('leave');
        expect(recommendedChoice({ ...base, column: 'unit_price' }).choice).toBe('leave');
    });

    it('applies nothing for a column without blanks and keeps rows otherwise intact', () => {
        const rows = [{ a: 1, b: 'x' }, { a: null, b: 'y' }];
        const columns = [{ name: 'a', type: ColumnType.METRIC }, { name: 'b', type: ColumnType.DIMENSION }] as any;
        const profiles = profileBlanks(rows, columns, { a: 'typical' });
        expect(profiles.map(p => p.column)).toEqual(['a']);
        const out = applyBlankDecisions(rows, profiles, { a: 'typical', b: 'remove' });
        expect(out.rows).toEqual([{ a: 1, b: 'x' }, { a: 1, b: 'y' }]);
        expect(out.logs).toHaveLength(1);
    });

    it('undoing one column keeps the other columns\' choices', () => {
        const next = buildReviewOptions({ blankDecisions: { discount: 'zero', region: 'remove' } }, {
            a: { kind: 'undo', revert: { option: 'blankDecisions', value: { region: 'remove' }, label: 'Leave them blank' } },
        });
        expect(next.blankDecisions).toEqual({ region: 'remove' });
    });
});

describe('is your data ready?', () => {
    const log = (step: string, status: ETLLog['status'], extra: Partial<ETLLog> = {}): ETLLog => ({ step, status, details: `${step} details`, timestamp: 1, ...extra });
    const columns = [
        { name: 'order_id', type: ColumnType.ID },
        { name: 'revenue', type: ColumnType.METRIC, currency: 'GBP' },
        { name: 'region', type: ColumnType.DIMENSION },
    ] as any;

    it('sorts the cleaning into fixed, to decide and good to know, each with why and without', () => {
        const logs = [
            log('Duplicate Row Removal', 'applied', { rowsBefore: 13, rowsAfter: 10, removedAmounts: { revenue: 4210, order_id: 0 }, revert: { option: 'keepDuplicateRows', value: true, label: 'Keep the copies' } }),
            log('Outlier Flag', 'info', { details: "Column 'revenue': 3 value(s) outside", affectedRows: 3, decision: { kind: 'outlier', column: 'revenue' } }),
            log('Missing Data Flag', 'info', { details: "Column 'region': 40% of values are missing" }),
            log('Empty Row Removal', 'skipped'),
            log('Empty Column Removal', 'skipped'),
            log('Final Summary', 'applied', { rowsBefore: 13, rowsAfter: 10 }),
        ];
        const ready = buildReadiness({ etlLogs: logs, columns });
        expect(ready.fixed).toHaveLength(1);
        const dup = ready.fixed[0];
        expect(dup.title).toBe('Removed 3 duplicate rows');
        expect(dup.why).toBeTruthy();
        expect(dup.without).toBeTruthy();
        expect(dup.impact).toBe('Without it, revenue £4,210 would be counted a second time.');
        expect(dup.revert?.label).toBe('Keep the copies');

        expect(ready.needsYou).toHaveLength(1);
        expect(ready.needsYou[0].choices?.map(c => c.id)).toEqual(['keep', 'remove', 'cap']);
        expect(ready.goodToKnow.map(i => i.title)).toEqual(["'region' is mostly empty"]);
        expect(ready.quiet).toBe(2);
        expect(ready.rowsUploaded).toBe(13);
        expect(ready.rowsAnalysed).toBe(10);
    });

    it('has a real explanation for every step the cleaning can report', () => {
        const steps = ['Empty Row Removal', 'Repeated Header Rows', 'Total Row Removal', 'Order Details Filled', 'Sheets Combined', 'Copied Sheet', 'Summary Sheet', 'Notes Sheet',
            'Sheets Kept Apart', 'Plan Sheets Kept Apart', 'Report Layout', 'Duplicate Row Removal', 'Empty Column Removal', 'Duplicate Column Removal', 'Auto-Merge Name Columns',
            'Unpivot Period Columns', 'Period From Year And Month', 'Mixed Currency Flag', 'Repeated Order-Level Amount', 'Line Cost Derived', 'Header Collision',
            'Null Token Standardization', 'Placeholder Values Removed', 'Placeholder Dates Removed', 'Units Removed', 'Percent Scale Standardized', 'Durations Converted',
            'Category Canonicalization', 'Coercion Loss Flag', 'Total Row Flag', 'Repeated Rows Kept', 'Ambiguous Date Flag', 'Line Total Mismatch Flag',
            'Revenue From Price × Quantity', 'Mixed Scale Flag', 'Impossible Values', 'Outlier Flag', 'Sign Anomaly Flag', 'Range Anomaly Flag', 'Date Order Flag',
            'Possible Typo Flag', 'Multi-Value Cell Flag', 'Missing Data Flag', 'Outlier Removal', 'Outlier Capping', 'Outlier Confirmed', 'Typo Merge', 'Typo Review',
            'Kept As Uploaded', 'Format Inconsistency Flag', 'Invalid Format Flag', 'Inconsistent Mapping Flag', 'Future Date Flag', 'Scale Shift Flag',
            'Near-Duplicate Rows Flag', 'Unusual Row Flag', 'Rule Violation Flag', 'Rule Applied', 'Missing Period Note', 'Constant Column Note',
            'Mixed Units Converted', 'Mixed Units Flag', 'Totals Check', 'Blank Values', 'Blanks Decision'];
        const generic = getStepGuide('zzz unknown step').title;
        const missing = steps.filter(step => getStepGuide(step).title === generic);
        expect(missing).toEqual([]);
        for (const step of steps) {
            const guide = getStepGuide(step);
            expect(guide.why.length).toBeGreaterThan(10);
            expect(guide.ifSkipped.length).toBeGreaterThan(0);
        }
        expect(getStepGuide('Repeated Header Rows').title).toBe('Repeated heading rows');
        expect(getStepGuide('Mixed Currency Flag').title).toBe('More than one currency in a column');
    });
});
