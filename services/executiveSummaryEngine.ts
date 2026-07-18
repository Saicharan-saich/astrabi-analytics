/**
 * executiveSummaryEngine.ts — Phase 4: Executive Summary
 *
 * Business owners don't just want charts — they want a conclusion. This turns the
 * ranked findings into a few sentences of plain business English:
 *
 *   "Across 5,000 patient records, two things need attention. Billing fell 14%
 *    this month, and one department (Cardiology) accounts for 42% of it — a
 *    concentration worth watching. On the upside, admissions rose for 4
 *    consecutive months. One data caveat: 22% of insurance values are missing."
 *
 * DETERMINISTIC and GROUNDED — every clause is assembled from a finding that was
 * computed from the data, so there are no invented numbers and no LLM call. The
 * numbers you read are the numbers in the data.
 */

import { Dataset } from '../types';
import { Finding } from './insightDiscoveryEngine';

export interface ExecutiveSummary {
    /** One-line takeaway. */
    headline: string;
    /** The full summary as ordered sentences (render joined, or as a list). */
    sentences: string[];
    /** How many findings the summary was synthesized from. */
    basedOn: number;
}

const list = (items: string[]): string => {
    if (items.length === 0) return '';
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
};

/** Lower-case a headline for mid-sentence use, keeping obvious proper-ish tokens. */
const clause = (headline: string): string => headline.charAt(0).toLowerCase() + headline.slice(1);

/**
 * Synthesize an executive summary from the ranked findings. Pure and
 * deterministic — safe to call on every dataset load.
 */
export function generateExecutiveSummary(findings: Finding[], dataset: Dataset): ExecutiveSummary {
    const rows = dataset?.rows?.length ?? 0;
    const domain = (dataset as any)?.domainProfile?.domain as string | undefined;
    const grain = (dataset as any)?.domainProfile?.grain as string | undefined;
    const noun = grain ? `${grain.toLowerCase()} records` : 'records';
    const scope = `Across ${rows.toLocaleString()} ${noun}${domain && domain !== 'General' ? ` (${domain})` : ''}`;

    if (!findings || findings.length === 0) {
        return {
            headline: 'No significant issues detected',
            sentences: [`${scope}, nothing crossed the thresholds for a material change, concentration, or data-quality concern.`],
            basedOn: 0,
        };
    }

    const attention = findings.filter(f => f.severity === 'critical' || f.severity === 'warning');
    const positive = findings.filter(f => f.severity === 'positive');
    const info = findings.filter(f => f.severity === 'info');
    const gaps = findings.filter(f => f.type === 'data_gap');
    const nonGapAttention = attention.filter(f => f.type !== 'data_gap');

    const sentences: string[] = [];

    // ── Lead sentence: frame the scope + how many need attention ──
    const attn = nonGapAttention.length;
    if (attn > 0) {
        sentences.push(`${scope}, ${attn === 1 ? 'one thing needs' : `${attn} things need`} attention.`);
    } else if (positive.length > 0) {
        sentences.push(`${scope}, the signals are mostly positive.`);
    } else {
        sentences.push(`${scope}, here's what stands out.`);
    }

    // ── The attention items (drops, streaks, concentration) — up to 3 ──
    if (nonGapAttention.length > 0) {
        sentences.push(`${capitalize(list(nonGapAttention.slice(0, 3).map(f => clause(f.headline))))}.`);
    }

    // ── The good news ──
    if (positive.length > 0) {
        sentences.push(`On the upside, ${list(positive.slice(0, 2).map(f => clause(f.headline)))}.`);
    }

    // ── Notable-but-not-urgent (Pareto, outliers) ──
    const notable = info.filter(f => f.type !== 'data_gap');
    if (notable.length > 0 && sentences.length < 4) {
        sentences.push(`Worth noting: ${list(notable.slice(0, 2).map(f => clause(f.headline)))}.`);
    }

    // ── Data-quality caveats last, so conclusions aren't over-trusted ──
    if (gaps.length > 0) {
        const g = gaps.slice(0, 2).map(f => clause(f.headline));
        sentences.push(`${gaps.length === 1 ? 'One data caveat' : 'Data caveats'}: ${list(g)} — treat related figures with care.`);
    }

    // ── Headline: the single most important thing ──
    const lead = nonGapAttention[0] || attention[0] || positive[0] || findings[0];
    const headline = lead ? lead.headline : 'Here’s what stands out in your data';

    return { headline, sentences, basedOn: findings.length };
}

function capitalize(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
