/**
 * Executive Summary — deterministic synthesis of findings into business English.
 * Every clause must be grounded in a real finding (no invented numbers), grouped
 * sensibly (attention → good news → notable → data caveats), and safe on empty.
 */
import { describe, it, expect } from 'vitest';
import { generateExecutiveSummary } from '../services/executiveSummaryEngine';
import type { Finding } from '../services/insightDiscoveryEngine';

const ds = (n: number, domain?: string, grain?: string): any => ({
    rows: Array.from({ length: n }, (_, i) => ({ i })),
    domainProfile: domain ? { domain, grain } : undefined,
});

const f = (over: Partial<Finding>): Finding => ({
    id: over.id || 'x', type: over.type || 'period_change', severity: over.severity || 'warning',
    headline: over.headline || 'Something happened', detail: '', score: over.score ?? 50, evidence: over.evidence || {},
    ...over,
});

describe('generateExecutiveSummary', () => {
    it('handles no findings without inventing anything', () => {
        const s = generateExecutiveSummary([], ds(1000, 'Sales'));
        expect(s.basedOn).toBe(0);
        expect(s.headline).toMatch(/no significant/i);
        expect(s.sentences.join(' ')).toMatch(/1,000/);
    });

    it('leads with the count of attention items and lists them', () => {
        const s = generateExecutiveSummary([
            f({ id: 'a', severity: 'critical', headline: 'Revenue fell 50%' }),
            f({ id: 'b', severity: 'warning', headline: 'One Department accounts for 42% of Revenue', type: 'concentration' }),
        ], ds(5000, 'Healthcare', 'Patient'));
        const text = s.sentences.join(' ');
        expect(text).toMatch(/2 things need attention/i);
        expect(text.toLowerCase()).toContain('revenue fell 50%');
        expect(text).toMatch(/patient records/i);
        expect(s.headline).toBe('Revenue fell 50%'); // most severe leads
    });

    it('separates good news, notable items, and data caveats', () => {
        const s = generateExecutiveSummary([
            f({ id: 'a', severity: 'warning', headline: 'Billing fell 14%' }),
            f({ id: 'b', severity: 'positive', headline: 'Admissions rose for 4 consecutive months', type: 'growth_streak' }),
            f({ id: 'c', severity: 'info', headline: 'Top 20% of doctors drive 80% of billing', type: 'pareto' }),
            f({ id: 'd', severity: 'warning', headline: '22% of Insurance values are missing', type: 'data_gap' }),
        ], ds(3000));
        const text = s.sentences.join(' ');
        expect(text).toMatch(/on the upside/i);
        expect(text.toLowerCase()).toContain('admissions rose');
        expect(text).toMatch(/worth noting/i);
        expect(text).toMatch(/caveat/i);
        expect(text.toLowerCase()).toContain('insurance');
        // A data-gap warning must NOT be counted as a headline attention item.
        expect(s.headline).toBe('Billing fell 14%');
    });

    it('a data gap alone still surfaces as a caveat, not silence', () => {
        const s = generateExecutiveSummary([f({ id: 'g', severity: 'warning', type: 'data_gap', headline: '30% of Email values are missing' })], ds(100));
        expect(s.sentences.join(' ')).toMatch(/caveat/i);
    });
});
