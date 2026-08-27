/**
 * Guards for the enforcement layer that used to rewrite good questions.
 *
 * "Sales for Coffee vs Tea, side by side" was classified as a TIME comparison
 * because of a bare /\bvs\b/ test. That upgraded the intent to
 * trend_comparison and injected `order_date BETWEEN 2025-06-30 AND 2025-06-30`
 * — a zero-width range that collapsed the answer to a single day.
 *
 * "vs" between two CATEGORY VALUES is a filtered breakdown, not a period
 * comparison. Only a comparison flanked by TIME words is the latter.
 */
import { describe, it, expect } from 'vitest';
import { isTimePeriodComparison } from '../services/ai-sql/intentPlanner';
import { classifyQuestion } from '../services/ai-sql/questionClassifier';

describe('isTimePeriodComparison — category vs period', () => {
    it('does NOT fire on comparisons between data values', () => {
        const categoryQuestions = [
            'Sales for Coffee vs Tea, side by side.',
            'Compare card vs cash payments',
            'London versus Manchester revenue',
            'How does Delivery compare to Dine-in?',
            'Widget vs Gadget by units sold',
        ];
        for (const q of categoryQuestions) {
            expect(isTimePeriodComparison(q), q).toBe(false);
        }
    });

    it('DOES fire when the comparison is between time periods', () => {
        const periodQuestions = [
            'How did sales this month compare to last month?',
            'Revenue this year vs last year',
            'this quarter versus previous quarter',
            'today vs yesterday',
            'Sales in 2024 vs 2023',
            'June vs July revenue',
            'show the comparision between this month and last month sales',
            'Compare this and last month sales',
            'Compare last and this month sales',
        ];
        for (const q of periodQuestions) {
            expect(isTimePeriodComparison(q), q).toBe(true);
        }
    });

    it('does not fire when a time phrase is present but is not what is being compared', () => {
        // The period scopes the question; Coffee and Tea are what is compared.
        expect(isTimePeriodComparison('Coffee vs Tea last month')).toBe(false);
    });

    it('ignores questions with no comparison language at all', () => {
        expect(isTimePeriodComparison('What were total sales?')).toBe(false);
        expect(isTimePeriodComparison('Top 5 products by revenue')).toBe(false);
    });
});

describe('classifyQuestion — the classifier agrees with the enforcement layer', () => {
    it('does not label a category comparison as a period comparison', () => {
        // Previously scored 0.80 "comparison", which drove the whole bad plan.
        expect(classifyQuestion('Sales for Coffee vs Tea, side by side.').intent).not.toBe('comparison');
        expect(classifyQuestion('Compare card vs cash payments').intent).not.toBe('comparison');
    });

    it('still labels a genuine period comparison', () => {
        expect(classifyQuestion('How did sales this month compare to last month?').intent).toBe('comparison');
        expect(classifyQuestion('Compare this and last month sales').intent).toBe('comparison');
    });

    it('recognises a plain counting question instead of giving up', () => {
        // Used to report intent=ambiguous, confidence=0.00.
        const r = classifyQuestion('How many customers ordered more than once?');
        expect(r.intent).toBe('single_metric');
        expect(r.confidence).toBeGreaterThan(0);
    });

    it('leaves a grouped count as a breakdown, not a scalar', () => {
        expect(classifyQuestion('How many orders per category?').intent).toBe('breakdown');
    });
});
