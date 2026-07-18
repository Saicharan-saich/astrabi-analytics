/**
 * investigationEngine.ts — Phase 3: Root-Cause Investigation + Analyst Reasoning
 *
 * A finding tells you WHAT happened ("Revenue fell 14%"). This engine encodes how
 * a human analyst finds out WHY: it walks a domain-aware reasoning path
 * (Time → Product → Customer → Region → Channel for sales; Facility → Doctor →
 * Condition → Insurance for healthcare; …), mapping each abstract angle to a real
 * column in the dataset and skipping the ones that don't exist.
 *
 * On top of the guided path, `buildContributionSQL` does the genuinely useful
 * deterministic root-cause math: for a metric that changed between two periods,
 * it decomposes the change by a dimension and ranks which categories drove it —
 * e.g. "the drop is mostly Product A (−$12K) and the East region (−$8K)".
 *
 * DETERMINISTIC — the reasoning paths are code, the contribution numbers are SQL
 * aggregates from DuckDB. No LLM, nothing leaves the browser.
 */

import { QueryConfig, AggregationType, AnalysisType } from '../types';
import { SemanticModel } from './semanticModel';
import { q, aggExpr, humanize, rankDimensions } from './autoInsightsEngine';
import type { Finding } from './insightDiscoveryEngine';
import { num } from './insightDiscoveryEngine';

export interface InvestigationStep {
    id: string;
    /** Natural-language question to run through the AI SQL pipeline. */
    question: string;
    /** Why an analyst asks this at this point in the path. */
    rationale: string;
    /** The column this step breaks the metric down by. */
    dimension: string;
    /** Ready-to-run Question Builder config. */
    drill: Partial<QueryConfig>;
}

export interface Investigation {
    finding: Finding;
    /** What we're explaining, in plain words. */
    subject: string;
    steps: InvestigationStep[];
}

// ── Role → column matching ──────────────────────────────────────────
// Each analyst "angle" is an abstract role; we resolve it to a real column by
// name pattern. Order within a role matters (more specific first).
const ROLE_PATTERNS: Record<string, RegExp> = {
    category: /\b(category|categories|type|segment|class|group|brand|line)\b/i,
    product: /\b(product|item|sku|service|good|model)\b/i,
    customer: /\b(customer|client|account|patient|member|buyer|subscriber|user)\b/i,
    region: /\b(region|state|province|country|city|location|geo|market|territory|area|zone|district)\b/i,
    channel: /\b(channel|source|platform|medium|campaign|referr|origin)\b/i,
    facility: /\b(hospital|facility|clinic|site|ward|unit|branch|store|center|centre)\b/i,
    doctor: /\b(doctor|physician|provider|surgeon|clinician|nurse|staff|rep|agent|salesperson|employee)\b/i,
    condition: /\b(condition|diagnosis|disease|illness|procedure|treatment|symptom|reason)\b/i,
    insurance: /\b(insurance|payer|plan|coverage|policy|carrier)\b/i,
    department: /\b(department|dept|division|team|function)\b/i,
    role: /\b(role|title|position|job|grade|level|seniority|rank)\b/i,
    manager: /\b(manager|supervisor|lead|head|director)\b/i,
    status: /\b(status|state|stage|phase|priority|tier)\b/i,
};

// Domain-aware order in which an analyst decomposes a metric.
const REASONING_PATHS: Record<string, string[]> = {
    healthcare: ['facility', 'doctor', 'condition', 'insurance', 'department', 'region'],
    hr: ['department', 'role', 'manager', 'region', 'status'],
    sales: ['category', 'product', 'customer', 'region', 'channel'],
    retail: ['category', 'product', 'customer', 'region', 'channel'],
    finance: ['category', 'region', 'channel', 'customer', 'status'],
    marketing: ['channel', 'campaign' as any, 'category', 'region', 'customer'],
    default: ['category', 'product', 'customer', 'region', 'channel', 'department', 'status'],
};

/** Resolve an abstract role to a real categorical column, or null. */
export function mapRole(role: string, model: SemanticModel): string | null {
    const pat = ROLE_PATTERNS[role];
    if (!pat) return null;
    // Normalize separators to spaces so \b word boundaries fire on snake_case /
    // kebab-case columns ("medical_condition" → "medical condition").
    const norm = (s: string) => s.replace(/[_-]+/g, ' ');
    const dims = model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden);
    const hit = dims.find(d => pat.test(norm(d.column)) || pat.test(norm(d.label || '')));
    return hit ? hit.column : null;
}

/** Pick the reasoning path for a domain string (case/spacing tolerant). */
function pathForDomain(domain?: string): string[] {
    const d = (domain || '').toLowerCase();
    for (const key of Object.keys(REASONING_PATHS)) {
        if (key !== 'default' && d.includes(key)) return REASONING_PATHS[key];
    }
    return REASONING_PATHS.default;
}

/** Find a measure's aggregation from the model (fallback SUM). */
function aggForColumn(model: SemanticModel, col?: string): AggregationType {
    const m = model.measures.find(x => x.column === col);
    return m?.aggregation || AggregationType.SUM;
}

/**
 * Build the guided investigation for a finding: an ordered set of drill-downs
 * following the analyst reasoning path for the dataset's domain, limited to the
 * columns that actually exist.
 */
export function buildInvestigation(
    finding: Finding,
    model: SemanticModel,
    domain?: string,
    maxSteps = 5,
): Investigation {
    const metricCol = finding.metric;
    const metricLabel = metricCol ? humanize(metricCol) : 'this metric';
    const agg = aggForColumn(model, metricCol);
    const temporal = finding.type === 'period_change' || finding.type === 'decline_streak' || finding.type === 'growth_streak';
    const direction = finding.evidence?.changePct != null
        ? (finding.evidence.changePct < 0 ? 'drop' : 'increase')
        : (finding.type === 'decline_streak' ? 'decline' : finding.type === 'growth_streak' ? 'rise' : 'difference');

    // Resolve the reasoning path to real columns (dedup, skip the finding's own dim).
    const path = pathForDomain(domain);
    const usedCols = new Set<string>(finding.dimension && finding.type !== 'period_change' ? [finding.dimension] : []);
    const steps: InvestigationStep[] = [];

    const addStep = (col: string, role: string) => {
        if (!col || usedCols.has(col)) return;
        usedCols.add(col);
        const dimLabel = humanize(col);
        const question = temporal
            ? `Which ${dimLabel.toLowerCase()} drove the ${direction} in ${metricLabel.toLowerCase()}?`
            : `Break down ${metricLabel.toLowerCase()} by ${dimLabel.toLowerCase()}.`;
        steps.push({
            id: `step:${col}`,
            question,
            rationale: `Look at ${metricLabel.toLowerCase()} by ${dimLabel.toLowerCase()} to isolate where the ${direction} is concentrated.`,
            dimension: col,
            drill: {
                metric: metricCol || '',
                dimension: col,
                aggregation: agg,
                analysisType: AnalysisType.STANDARD,
                sort: 'desc',
                limit: 10,
                chartType: 'horizontalBar' as any,
            },
        });
    };

    for (const role of path) {
        if (steps.length >= maxSteps) break;
        const col = mapRole(role, model);
        if (col) addStep(col, role);
    }

    // Fallback: if the domain path matched nothing (unusual column names), use the
    // highest-value categorical dimensions so the investigation is never empty.
    if (steps.length === 0) {
        const dims = rankDimensions(model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden && d.column !== finding.dimension));
        for (const d of dims.slice(0, maxSteps)) addStep(d.column, 'dimension');
    }

    return {
        finding,
        subject: temporal
            ? `Why ${metricLabel.toLowerCase()} ${direction === 'drop' ? 'dropped' : direction === 'increase' || direction === 'rise' ? 'rose' : 'changed'}`
            : `What's behind "${finding.headline}"`,
        steps: steps.slice(0, maxSteps),
    };
}

// ── Deterministic root-cause contribution ───────────────────────────

/** Conditional aggregate for one period, honoring the measure's aggregation. */
function aggConditional(agg: AggregationType, col: string, cond: string): string {
    const c = q(col);
    switch (agg) {
        case AggregationType.COUNT: return `COUNT(CASE WHEN ${cond} THEN ${c} END)`;
        case AggregationType.COUNT_DISTINCT: return `COUNT(DISTINCT CASE WHEN ${cond} THEN ${c} END)`;
        case AggregationType.AVG: return `AVG(CASE WHEN ${cond} THEN TRY_CAST(${c} AS DOUBLE) END)`;
        case AggregationType.MIN: return `MIN(CASE WHEN ${cond} THEN TRY_CAST(${c} AS DOUBLE) END)`;
        case AggregationType.MAX: return `MAX(CASE WHEN ${cond} THEN TRY_CAST(${c} AS DOUBLE) END)`;
        default: return `SUM(CASE WHEN ${cond} THEN TRY_CAST(${c} AS DOUBLE) END)`;
    }
}

/**
 * SQL that decomposes a metric's change between two YYYY-MM periods across a
 * dimension: one row per category with its value in each period. Ranking (by
 * absolute delta) is done in JS by `rankContributors`.
 */
export function buildContributionSQL(
    metricCol: string,
    agg: AggregationType,
    dateCol: string,
    dimCol: string,
    prevPeriod: string,
    latestPeriod: string,
): string {
    const period = (p: string) => `strftime(TRY_CAST(${q(dateCol)} AS DATE), '%Y-%m') = '${p.replace(/'/g, "''")}'`;
    const cur = aggConditional(agg, metricCol, period(latestPeriod));
    const prv = aggConditional(agg, metricCol, period(prevPeriod));
    return `SELECT ${q(dimCol)} AS label, ${cur} AS current_v, ${prv} AS previous_v `
        + `FROM data WHERE ${q(dimCol)} IS NOT NULL AND TRY_CAST(${q(dateCol)} AS DATE) IS NOT NULL `
        + `GROUP BY ${q(dimCol)} `
        + `ORDER BY ABS(COALESCE(${cur}, 0) - COALESCE(${prv}, 0)) DESC LIMIT 8`;
}

export interface Contributor {
    label: string;
    current: number;
    previous: number;
    delta: number;
    /** Share of the total absolute change this category represents (0–1). */
    share: number;
}

/** Rank contributors by absolute delta and compute each one's share of the change. */
export function rankContributors(rows: Array<{ label: any; current_v: any; previous_v: any }>): Contributor[] {
    const parsed = rows.map(r => {
        const current = num(r.current_v) || 0;
        const previous = num(r.previous_v) || 0;
        return { label: String(r.label), current, previous, delta: current - previous };
    });
    const totalAbs = parsed.reduce((a, c) => a + Math.abs(c.delta), 0) || 1;
    return parsed
        .map(c => ({ ...c, share: Math.abs(c.delta) / totalAbs }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

/** A one-sentence plain-language read of the top contributors. */
export function summarizeContributors(contributors: Contributor[], metricCol: string): string {
    if (contributors.length === 0) return '';
    const label = humanize(metricCol);
    const top = contributors.slice(0, 2).filter(c => c.delta !== 0);
    if (top.length === 0) return `No single category explains the change in ${label.toLowerCase()}.`;
    const parts = top.map(c => `${c.label} (${c.delta > 0 ? '+' : '−'}${Math.abs(c.delta) >= 1000 ? `${(Math.abs(c.delta) / 1000).toFixed(1)}K` : Math.round(Math.abs(c.delta)).toLocaleString()})`);
    return `Most of the change in ${label.toLowerCase()} comes from ${parts.join(' and ')}.`;
}
