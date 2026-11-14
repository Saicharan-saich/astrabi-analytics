/**
 * No accuracy figure is shown until live test runs earn it: the latest two
 * full runs must each reach 98%, and the figure is never rounded up.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accuracyClaimFrom, publicAccuracyClaim } from '../config/accuracyClaim';

const rules = { threshold: 0.98, consecutiveRuns: 2, minimumQuestions: 75 };
const run = (passed: number, total = 100) => ({ date: '2026-12', suite: 'owner', passed, total });

describe('public accuracy claim', () => {
    it('is not made today (72 of 77 twice is below 98%)', () => {
        expect(publicAccuracyClaim).toBeNull();
    });

    it('needs the latest two full runs to reach 98%', () => {
        expect(accuracyClaimFrom({ ...rules, runs: [run(99)] })).toBeNull();
        expect(accuracyClaimFrom({ ...rules, runs: [run(99), run(97)] })).toBeNull();
        expect(accuracyClaimFrom({ ...rules, runs: [run(99), run(98), run(90)] })).toBeNull();
        expect(accuracyClaimFrom({ ...rules, runs: [run(99, 50), run(50, 50)] })).toBeNull();
        expect(accuracyClaimFrom({ ...rules, runs: [run(40), run(98), run(99)] }))
            .toBe('In our last 2 test runs of 100 real business questions, at least 98% were answered correctly.');
    });

    it('states the lower run, rounded down', () => {
        expect(accuracyClaimFrom({ ...rules, runs: [run(79, 80), run(80, 80)] })).toContain('at least 98.7%');
    });

    it('is the only way a figure reaches the public pages', () => {
        const pages = ['components/PricingDialog.tsx', 'components/LoginPage.tsx', 'components/PreLoginTour.tsx', 'components/LegalPage.tsx', 'index.html'];
        for (const page of pages) {
            const text = readFileSync(join(process.cwd(), page), 'utf8');
            expect({ page, claim: text.match(/\d{2,3}(?:\.\d+)?\s?%[^.\n]{0,40}(?:accura|correct|right)|(?:accura|correct)[^.\n]{0,40}\d{2,3}(?:\.\d+)?\s?%/i)?.[0] ?? null })
                .toEqual({ page, claim: null });
        }
    });
});
