/**
 * insightDiscoveryEngine.ts — Phase 1 of the Insight Discovery Engine
 *
 * Instead of asking the user to type a question, this engine inspects the data
 * and surfaces FINDINGS — a headline + severity + magnitude + evidence + a
 * suggested drill-down — like an analyst reading the dataset for you:
 *
 *   ⚠ Monthly Revenue fell 14% (Jun vs May)
 *   ⚠ One Customer ("Acme Corp") accounts for 42% of Billing Amount
 *   ✓ Admissions rose for 4 consecutive months
 *
 * 100% DETERMINISTIC — every finding is computed from aggregates in DuckDB.
 * NO LLM is involved in DETECTION (only Phase 4's executive summary uses AI,
 * and even then only the computed findings — never raw rows). The category
 * labels shown here are the user's own values displayed locally in their
 * browser; nothing leaves the machine.
 *
 * The hard part of this engine is NOT the SQL — it's ranking and suppression.
 * "24 opportunities" only impresses if all 24 are real, so each detector has a
 * MATERIALITY FLOOR (a change must clear a threshold to become a finding) and
 * findings are de-duplicated and ranked by severity × magnitude before display.
 */

import { Dataset, QueryConfig, AggregationType, TimeGrain, AnalysisType } from '../types';
import { SemanticModel, SemanticMeasure, SemanticDimension } from './semanticModel';
import { executeSQLViaDuckDB, reloadDataTable } from './duckdbEngine';
import { q, aggExpr, humanize, sanitizeRows, getBusinessMeasures, rankDimensions } from './autoInsightsEngine';

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export type FindingType =
    | 'period_change'    // metric jumped/dropped vs the previous period
    | 'decline_streak'   // metric fell for N consecutive periods
    | 'growth_streak'    // metric rose for N consecutive periods
    | 'concentration'    // one category dominates a measure (single-point risk)
    | 'pareto'           // a small share of categories drive most of the total
    | 'category_outlier' // one category sits far above/below its peers
    | 'data_gap';        // a meaningful share of a column's values is missing

export type FindingSeverity = 'critical' | 'warning' | 'positive' | 'info';

export interface Finding {
    id: string;
    type: FindingType;
    severity: FindingSeverity;
    /** Short, human headline shown in the feed. */
    headline: string;
    /** One sentence of plain-language explanation. */
    detail: string;
    /** The measure column this finding is about (if any). */
    metric?: string;
    /** The dimension column this finding is about (if any). */
    dimension?: string;
    /** Ranking score — severity × magnitude. Higher = surfaced first. */
    score: number;
    /** The raw numbers behind the finding (for tooltips / the drill-down). */
    evidence: Record<string, any>;
    /** A ready-to-run Question Builder config so the user can drill in. */
    drill?: Partial<QueryConfig>;
    /** A natural-language follow-up the user "might also want to ask". */
    suggestedQuestion?: string;
}

// How strongly each severity weighs in the ranking.
const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
    critical: 100,
    warning: 60,
    positive: 45,
    info: 25,
};

// Materiality floors — a signal must clear these to become a finding at all.
// This is the difference between "24 real opportunities" and "24 pieces of noise".
export const THRESHOLDS = {
    periodChangePct: 0.10,       // ±10% period-over-period
    criticalChangePct: 0.30,     // ≥30% swing → critical
    streakLength: 3,             // ≥3 consecutive moves
    concentrationShare: 0.30,    // one category ≥30% of the total
    paretoTopShare: 0.80,        // top 20% of categories ≥80% of total
    outlierZ: 2.0,               // ≥2 std devs from the peer mean
    dataGapShare: 0.20,          // ≥20% of values missing
    minPeriods: 3,               // need at least 3 periods for a trend
    minCategoriesForOutlier: 6,  // need enough peers for a meaningful std dev
    maxFindings: 12,             // cap the feed — the top signals only
};

// ═══════════════════════════════════════════════════════════════════
// SMALL NUMERIC HELPERS
// ═══════════════════════════════════════════════════════════════════

/** DuckDB serialises HUGEINT sums as strings and may quote values — coerce safely. */
export function num(v: any): number {
    if (v === null || v === undefined) return NaN;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'number') return v;
    return Number(String(v).replace(/"/g, ''));
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const pct = (x: number) => `${(x * 100).toFixed(x >= 0.1 ? 0 : 1)}%`;

function isCurrency(m: SemanticMeasure): boolean {
    return m.format === 'currency_usd' || m.format === 'currency_eur';
}

/** A measure where "went up" is good news (revenue/sales) vs. neutral (counts). */
function higherIsBetter(m: SemanticMeasure): boolean {
    return isCurrency(m) || /\b(revenue|sales|profit|income|billing|amount|gmv|bookings)\b/i.test(m.column);
}

// ═══════════════════════════════════════════════════════════════════
// SQL BUILDERS (aggregate-only — no raw rows returned)
// ═══════════════════════════════════════════════════════════════════

/** One row per month: the measure aggregated over the primary date column. */
export function buildPeriodSQL(measure: SemanticMeasure, dateCol: string): string {
    return `SELECT strftime(TRY_CAST(${q(dateCol)} AS DATE), '%Y-%m') AS period, ${aggExpr(measure)} AS v `
        + `FROM data WHERE TRY_CAST(${q(dateCol)} AS DATE) IS NOT NULL `
        + `GROUP BY period ORDER BY period`;
}

/** One row per category: the measure aggregated by a dimension, biggest first. */
export function buildGroupSQL(dim: SemanticDimension, measure: SemanticMeasure): string {
    return `SELECT ${q(dim.column)} AS label, ${aggExpr(measure)} AS v `
        + `FROM data WHERE ${q(dim.column)} IS NOT NULL AND TRIM(CAST(${q(dim.column)} AS VARCHAR)) <> '' `
        + `GROUP BY ${q(dim.column)} ORDER BY v DESC`;
}

/** Row count vs. non-null count for a column, to measure completeness. */
export function buildGapSQL(col: string): string {
    return `SELECT COUNT(*) AS total, COUNT(${q(col)}) AS nonnull FROM data`;
}

// ═══════════════════════════════════════════════════════════════════
// PURE ANALYZERS — take aggregate rows, return findings. Fully testable
// without DuckDB.
// ═══════════════════════════════════════════════════════════════════

/**
 * From a monthly series, detect (a) the latest period-over-period change and
 * (b) a decline/growth streak at the tail. Both share the same series so we
 * compute them together.
 */
export function analyzePeriodSeries(
    rows: Array<{ period: string; v: any }>,
    measure: SemanticMeasure,
    dateCol: string,
): Finding[] {
    const series = rows
        .map(r => ({ period: String(r.period), v: num(r.v) }))
        .filter(p => p.period && Number.isFinite(p.v));
    if (series.length < THRESHOLDS.minPeriods) return [];

    const label = humanize(measure.column);
    const findings: Finding[] = [];
    const drill: Partial<QueryConfig> = {
        metric: measure.column,
        dimension: dateCol,
        aggregation: measure.aggregation,
        timeGrain: TimeGrain.MONTH,
        analysisType: AnalysisType.STANDARD,
        chartType: 'line' as any,
    };

    // ── (a) Latest period-over-period change ──────────────────────────
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    if (prev.v !== 0) {
        const change = (last.v - prev.v) / Math.abs(prev.v);
        if (Math.abs(change) >= THRESHOLDS.periodChangePct) {
            const up = change > 0;
            const good = up === higherIsBetter(measure);
            const critical = Math.abs(change) >= THRESHOLDS.criticalChangePct;
            const severity: FindingSeverity = good ? 'positive' : (critical ? 'critical' : 'warning');
            const verb = up ? 'rose' : 'fell';
            findings.push({
                id: `period_change:${measure.column}`,
                type: 'period_change',
                severity,
                headline: `${label} ${verb} ${pct(Math.abs(change))} (${prev.period} → ${last.period})`,
                detail: `${label} went from ${last.v >= prev.v ? '' : ''}${fmtNum(prev.v, measure)} in ${prev.period} to ${fmtNum(last.v, measure)} in ${last.period}, a ${pct(Math.abs(change))} ${up ? 'increase' : 'decrease'}.`,
                metric: measure.column,
                dimension: dateCol,
                score: SEVERITY_WEIGHT[severity] * (0.6 + 0.4 * clamp01(Math.abs(change))),
                evidence: { previous: prev.v, latest: last.v, changePct: change, previousPeriod: prev.period, latestPeriod: last.period },
                drill,
                suggestedQuestion: `What drove the ${verb === 'fell' ? 'drop' : 'change'} in ${label.toLowerCase()} in ${last.period}?`,
            });
        }
    }

    // ── (b) Streak at the tail (consecutive up or down moves) ─────────
    let dir = 0, streak = 0;
    for (let i = series.length - 1; i > 0; i--) {
        const d = Math.sign(series[i].v - series[i - 1].v);
        if (d === 0) break;
        if (dir === 0) { dir = d; streak = 1; }
        else if (d === dir) streak++;
        else break;
    }
    if (streak >= THRESHOLDS.streakLength && dir !== 0) {
        const up = dir > 0;
        const good = up === higherIsBetter(measure);
        const severity: FindingSeverity = good ? 'positive' : 'warning';
        const runLen = streak + 1; // moves imply runLen periods involved
        findings.push({
            id: `${up ? 'growth' : 'decline'}_streak:${measure.column}`,
            type: up ? 'growth_streak' : 'decline_streak',
            severity,
            headline: `${label} ${up ? 'rose' : 'declined'} for ${streak} consecutive months`,
            detail: `${label} has moved ${up ? 'up' : 'down'} every month for the last ${streak} months (${series[series.length - runLen].period} → ${series[series.length - 1].period}).`,
            metric: measure.column,
            dimension: dateCol,
            score: SEVERITY_WEIGHT[severity] * (0.6 + 0.4 * clamp01(streak / 6)),
            evidence: { streak, direction: up ? 'up' : 'down', from: series[series.length - runLen].period, to: series[series.length - 1].period },
            drill,
            suggestedQuestion: `Show the monthly trend of ${label.toLowerCase()}.`,
        });
    }

    // ── (c) Seasonality Detection ─────────────────────────────────────
    if (series.length >= 24) {
        if (/^\d{4}-\d{2}$/.test(series[0].period)) {
            const yearlyData: Record<string, { sum: number, count: number, avg: number, months: Record<string, number> }> = {};
            for (const p of series) {
                const parts = p.period.split('-');
                const year = parts[0];
                const month = parts[1];
                if (!yearlyData[year]) yearlyData[year] = { sum: 0, count: 0, avg: 0, months: {} };
                yearlyData[year].sum += p.v;
                yearlyData[year].count++;
                yearlyData[year].months[month] = p.v;
            }
            
            let completeYears = 0;
            for (const year in yearlyData) {
                if (yearlyData[year].count === 12) {
                    completeYears++;
                    yearlyData[year].avg = yearlyData[year].sum / 12;
                }
            }
            
            if (completeYears >= 2) {
                const monthPatterns: Record<string, number> = {};
                for (let m = 1; m <= 12; m++) {
                    const monthStr = String(m).padStart(2, '0');
                    let allAbove = true;
                    let allBelow = true;
                    let numYears = 0;
                    
                    for (const year in yearlyData) {
                        if (yearlyData[year].count === 12) {
                            numYears++;
                            const val = yearlyData[year].months[monthStr];
                            const avg = yearlyData[year].avg;
                            if (val <= avg) allAbove = false;
                            if (val >= avg) allBelow = false;
                        }
                    }
                    
                    if (numYears >= 2) {
                        if (allAbove) monthPatterns[monthStr] = 1;
                        if (allBelow) monthPatterns[monthStr] = -1;
                    }
                }
                
                const highMonths = Object.keys(monthPatterns).filter(m => monthPatterns[m] === 1);
                const lowMonths = Object.keys(monthPatterns).filter(m => monthPatterns[m] === -1);
                
                if (highMonths.length > 0 || lowMonths.length > 0) {
                    const monthNames = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
                    const highNames = highMonths.map(m => monthNames[parseInt(m)]).join(', ');
                    const lowNames = lowMonths.map(m => monthNames[parseInt(m)]).join(', ');
                    const isHigh = highMonths.length > 0;
                    const severity: FindingSeverity = 'info';
                    findings.push({
                        id: `seasonality:${measure.column}`,
                        type: 'period_change' as any,
                        severity,
                        headline: `${label} shows consistent seasonality`,
                        detail: `Across multiple years, ${label.toLowerCase()} is consistently ${isHigh ? 'higher' : 'lower'} in ${isHigh ? highNames : lowNames} compared to the annual average.`,
                        metric: measure.column,
                        dimension: dateCol,
                        score: SEVERITY_WEIGHT[severity] * 0.8,
                        evidence: { highMonths, lowMonths },
                        drill,
                        suggestedQuestion: `What drives the seasonal trend in ${label.toLowerCase()} during ${isHigh ? highNames : lowNames}?`,
                    });
                }
            }
        }
    }

    return findings;
}

/**
 * From a measure grouped by a dimension, detect concentration (one category
 * dominates) and Pareto (a small share of categories drive most of the total).
 */
export function analyzeConcentration(
    rows: Array<{ label: any; v: any }>,
    dim: SemanticDimension,
    measure: SemanticMeasure,
): Finding[] {
    const groups = rows
        .map(r => ({ label: String(r.label), v: num(r.v) }))
        .filter(g => Number.isFinite(g.v) && g.v > 0)
        .sort((a, b) => b.v - a.v);
    if (groups.length < 5) return []; // need real variety to talk about concentration

    const total = groups.reduce((a, g) => a + g.v, 0);
    if (total <= 0) return [];

    const dLabel = humanize(dim.column);
    const mLabel = humanize(measure.column);
    const findings: Finding[] = [];
    const drill: Partial<QueryConfig> = {
        metric: measure.column,
        dimension: dim.column,
        aggregation: measure.aggregation,
        analysisType: AnalysisType.STANDARD,
        sort: 'desc',
        limit: 10,
        chartType: 'horizontalBar' as any,
    };

    // ── Single-category concentration (a risk worth flagging) ──────────
    const top = groups[0];
    const topShare = top.v / total;
    if (topShare >= THRESHOLDS.concentrationShare) {
        const critical = topShare >= 0.5;
        const severity: FindingSeverity = critical ? 'critical' : 'warning';
        findings.push({
            id: `concentration:${dim.column}:${measure.column}`,
            type: 'concentration',
            severity,
            headline: `One ${dLabel} ("${top.label}") accounts for ${pct(topShare)} of ${mLabel}`,
            detail: `${top.label} makes up ${pct(topShare)} of total ${mLabel.toLowerCase()} across ${groups.length} ${dLabel.toLowerCase()} values — a concentration risk if that ${dLabel.toLowerCase()} changes.`,
            metric: measure.column,
            dimension: dim.column,
            score: SEVERITY_WEIGHT[severity] * (0.6 + 0.4 * clamp01(topShare)),
            evidence: { topLabel: top.label, topValue: top.v, total, share: topShare, categories: groups.length },
            drill,
            suggestedQuestion: `How has ${mLabel.toLowerCase()} from ${top.label} changed over time?`,
        });
    } else {
        // ── Pareto (80/20): only if not already dominated by one category ──
        const topCount = Math.max(1, Math.ceil(groups.length * 0.2));
        const topSum = groups.slice(0, topCount).reduce((a, g) => a + g.v, 0);
        const paretoShare = topSum / total;
        if (groups.length >= 10 && paretoShare >= THRESHOLDS.paretoTopShare) {
            findings.push({
                id: `pareto:${dim.column}:${measure.column}`,
                type: 'pareto',
                severity: 'info',
                headline: `Top ${pct(topCount / groups.length)} of ${dLabel} drive ${pct(paretoShare)} of ${mLabel}`,
                detail: `${topCount} of ${groups.length} ${dLabel.toLowerCase()} values account for ${pct(paretoShare)} of total ${mLabel.toLowerCase()} — a classic 80/20 pattern worth focusing on.`,
                metric: measure.column,
                dimension: dim.column,
                score: SEVERITY_WEIGHT.info * (0.6 + 0.4 * clamp01(paretoShare)),
                evidence: { topCount, categories: groups.length, share: paretoShare },
                drill,
                suggestedQuestion: `Which ${dLabel.toLowerCase()} values contribute most to ${mLabel.toLowerCase()}?`,
            });
        }
    }

    return findings;
}

/**
 * From a measure grouped by a dimension, detect a category that sits far from
 * its peers (z-score outlier).
 */
export function analyzeOutliers(
    rows: Array<{ label: any; v: any }>,
    dim: SemanticDimension,
    measure: SemanticMeasure,
): Finding[] {
    const groups = rows
        .map(r => ({ label: String(r.label), v: num(r.v) }))
        .filter(g => Number.isFinite(g.v));
    if (groups.length < THRESHOLDS.minCategoriesForOutlier) return [];

    const mean = groups.reduce((a, g) => a + g.v, 0) / groups.length;
    const variance = groups.reduce((a, g) => a + (g.v - mean) ** 2, 0) / groups.length;
    const std = Math.sqrt(variance);
    if (std === 0) return [];

    // Strongest outlier only — one per (dim, measure) keeps the feed clean.
    let best = groups[0], bestZ = 0;
    for (const g of groups) {
        const z = (g.v - mean) / std;
        if (Math.abs(z) > Math.abs(bestZ)) { bestZ = z; best = g; }
    }
    if (Math.abs(bestZ) < THRESHOLDS.outlierZ || mean === 0) return [];

    const dLabel = humanize(dim.column);
    const mLabel = humanize(measure.column);
    const above = bestZ > 0;
    const relPct = Math.abs((best.v - mean) / mean);
    return [{
        id: `outlier:${dim.column}:${measure.column}`,
        type: 'category_outlier',
        severity: 'info',
        headline: `${dLabel} "${best.label}" has ${mLabel} ${pct(relPct)} ${above ? 'above' : 'below'} average`,
        detail: `${best.label}'s ${mLabel.toLowerCase()} (${fmtNum(best.v, measure)}) is ${Math.abs(bestZ).toFixed(1)} standard deviations ${above ? 'above' : 'below'} the ${dLabel.toLowerCase()} average of ${fmtNum(mean, measure)}.`,
        metric: measure.column,
        dimension: dim.column,
        score: SEVERITY_WEIGHT.info * (0.6 + 0.4 * clamp01(Math.abs(bestZ) / 4)),
        evidence: { label: best.label, value: best.v, mean, std, z: bestZ },
        drill: {
            metric: measure.column,
            dimension: dim.column,
            aggregation: measure.aggregation,
            analysisType: AnalysisType.STANDARD,
            sort: 'desc',
            chartType: 'horizontalBar' as any,
        },
        suggestedQuestion: `Why is ${mLabel.toLowerCase()} so ${above ? 'high' : 'low'} for ${best.label}?`,
    }];
}

/** Flag a column with a meaningful share of missing values. */
export function analyzeGap(
    row: { total: any; nonnull: any },
    col: string,
): Finding | null {
    const total = num(row.total);
    const nonnull = num(row.nonnull);
    if (!Number.isFinite(total) || total <= 0) return null;
    const missing = 1 - nonnull / total;
    if (missing < THRESHOLDS.dataGapShare) return null;
    const label = humanize(col);
    return {
        id: `data_gap:${col}`,
        type: 'data_gap',
        severity: 'warning',
        headline: `${pct(missing)} of ${label} values are missing`,
        detail: `${Math.round((total - nonnull)).toLocaleString()} of ${Math.round(total).toLocaleString()} rows have no ${label.toLowerCase()} — results that rely on this column may be incomplete.`,
        dimension: col,
        score: SEVERITY_WEIGHT.warning * (0.5 + 0.5 * clamp01(missing)),
        evidence: { total, nonnull, missingShare: missing },
        suggestedQuestion: `Which records are missing ${label.toLowerCase()}?`,
    };
}

/** Format a number for a headline using the measure's format. */
function fmtNum(v: number, measure: SemanticMeasure): string {
    if (measure.format === 'percent') return `${(v * 100).toFixed(1)}%`;
    const abs = Math.abs(v);
    const compact = abs >= 1e9 ? `${(v / 1e9).toFixed(1)}B`
        : abs >= 1e6 ? `${(v / 1e6).toFixed(1)}M`
        : abs >= 1e3 ? `${(v / 1e3).toFixed(1)}K`
        : `${Math.round(v).toLocaleString()}`;
    return isCurrency(measure) ? `$${compact}` : compact;
}

/**
 * Rank findings by score, drop duplicates (same type+metric+dimension), and cap
 * to the top N so the feed shows the signals that matter, not everything true.
 */
export function rankFindings(findings: Finding[], max = THRESHOLDS.maxFindings): Finding[] {
    const seen = new Set<string>();
    const unique: Finding[] = [];
    for (const f of [...findings].sort((a, b) => b.score - a.score)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        unique.push(f);
    }
    return unique.slice(0, max);
}

// ═══════════════════════════════════════════════════════════════════
// ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════

export function analyzeCorrelation(
    cleanRows: any[],
    measures: SemanticMeasure[]
): Finding[] {
    const findings: Finding[] = [];
    if (measures.length < 2) return findings;
    
    for (let i = 0; i < measures.length; i++) {
        for (let j = i + 1; j < measures.length; j++) {
            const m1 = measures[i];
            const m2 = measures[j];
            
            let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
            let n = 0;
            
            for (const row of cleanRows) {
                const x = num(row[m1.column]);
                const y = num(row[m2.column]);
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    sumX += x;
                    sumY += y;
                    sumXY += x * y;
                    sumX2 += x * x;
                    sumY2 += y * y;
                    n++;
                }
            }
            
            if (n > 2) {
                const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
                if (denom !== 0) {
                    const r = (n * sumXY - sumX * sumY) / denom;
                    if (Math.abs(r) > 0.7) {
                        const m1Label = humanize(m1.column);
                        const m2Label = humanize(m2.column);
                        const direction = r > 0 ? 'positively' : 'negatively';
                        findings.push({
                            id: `correlation:${m1.column}:${m2.column}`,
                            type: 'period_change' as any, // fallback type
                            severity: 'info',
                            headline: `${m1Label} and ${m2Label} are strongly ${direction} correlated`,
                            detail: `These two metrics move together with a correlation of ${r.toFixed(2)}.`,
                            metric: m1.column,
                            score: SEVERITY_WEIGHT.info * (0.5 + 0.5 * Math.abs(r)),
                            evidence: { r, n },
                            suggestedQuestion: `Why do ${m1Label.toLowerCase()} and ${m2Label.toLowerCase()} trend together?`,
                        });
                    }
                }
            }
        }
    }
    return findings;
}

/** Candidate dimensions: categorical, visible, not ID-like, ranked by value. */
function candidateDimensions(model: SemanticModel): SemanticDimension[] {
    return rankDimensions(model.dimensions.filter(d => d.dataType === 'string' && !d.isHidden)).slice(0, 4);
}

/**
 * Inspect the dataset and return the ranked findings. Runs a battery of
 * deterministic aggregate queries in DuckDB, analyzes them in JS, then ranks
 * and caps. Never throws — a failed detector is skipped, not fatal.
 */
export async function discoverInsights(dataset: Dataset): Promise<Finding[]> {
    const t0 = performance.now();
    const model = dataset.semanticModel as SemanticModel | undefined;
    if (!model) {
        console.warn('[InsightDiscovery] No semantic model on dataset — nothing to discover.');
        return [];
    }

    const measures = getBusinessMeasures(model).slice(0, 3);
    const dims = candidateDimensions(model);
    const dateCol = model.primaryDateColumn;

    const cleanRows = sanitizeRows(dataset.rows);
    try {
        await reloadDataTable(cleanRows);
    } catch (err: any) {
        console.error('[InsightDiscovery] Failed to load data into DuckDB:', err?.message);
        return [];
    }

    const findings: Finding[] = [];
    const runSQL = async (sql: string) => {
        const res = await executeSQLViaDuckDB(cleanRows, sql, dataset.timeContext as any);
        if (res.error) { console.warn('[InsightDiscovery] query failed:', res.error); return null; }
        return res.data || [];
    };

    // ── Time-based detectors (period change + streaks) ────────────────
    if (dateCol) {
        for (const m of measures) {
            try {
                const data = await runSQL(buildPeriodSQL(m, dateCol));
                if (data) findings.push(...analyzePeriodSeries(data as any, m, dateCol));
            } catch (e: any) { console.warn(`[InsightDiscovery] period(${m.column}) failed:`, e?.message); }
        }
    }

    // ── Cross-sectional detectors (concentration + outliers) ──────────
    for (const dim of dims) {
        for (const m of measures) {
            try {
                const data = await runSQL(buildGroupSQL(dim, m));
                if (data) {
                    findings.push(...analyzeConcentration(data as any, dim, m));
                    findings.push(...analyzeOutliers(data as any, dim, m));
                }
            } catch (e: any) { console.warn(`[InsightDiscovery] group(${dim.column},${m.column}) failed:`, e?.message); }
        }
    }

    // ── Data-quality detectors (missing values) ───────────────────────
    const gapCols = [...measures.map(m => m.column), ...dims.map(d => d.column)].slice(0, 6);
    for (const col of gapCols) {
        try {
            const data = await runSQL(buildGapSQL(col));
            if (data && data[0]) {
                const g = analyzeGap(data[0] as any, col);
                if (g) findings.push(g);
            }
        } catch (e: any) { console.warn(`[InsightDiscovery] gap(${col}) failed:`, e?.message); }
    }

    // ── Cross-Metric Correlation ──────────────────────────────────────
    findings.push(...analyzeCorrelation(cleanRows, measures));

    const ranked = rankFindings(findings);
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`[InsightDiscovery] ${ranked.length} findings (from ${findings.length} raw) in ${elapsed}s`);
    return ranked;
}
