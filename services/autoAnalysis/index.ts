/**
 * Auto analysis — the report.
 *
 * buildAutoReport(dataset) reads the data the way an analyst would on a first
 * pass and returns:
 *   - headline KPIs for the latest complete period, with their change
 *   - ranked findings (trend, what drove the change, mix vs rate, concentration,
 *     growth by segment, segments that stand out, weekly rhythm, distribution),
 *     each with a chart that shows the evidence
 *   - a short executive summary and honest data notes (incomplete periods,
 *     missing values)
 *
 * Both the Discover report and the auto-built dashboard use it, and every card
 * carries a spec so it can be recomputed on refresh or under dashboard filters.
 */

import type { Dataset } from '../../types';
import { chooseFocus, prepare, toNumber, type Focus, type MetricDef, type Prepared } from './core';
import {
    ANALYZERS, analyzeConcentration, analyzeDistribution, analyzeDrivers, analyzeGrowth, analyzeKpi, analyzeMix,
    analyzeSegmentRatio, analyzeTrend, analyzeWeekday,
    type AutoCardSpec, type AutoFinding,
} from './analyzers';

export type { AutoFinding, AutoCard, AutoCardSpec, Tone } from './analyzers';
export type { Focus, MetricDef } from './core';

export interface AutoReport {
    datasetId: string;
    title: string;
    /** "1,188 orders · Jan 2024 – Mar 2026 · by month" */
    scope: string;
    summary: string[];
    kpis: AutoFinding[];
    findings: AutoFinding[];
    notes: string[];
    focus: Focus;
    generatedAt: number;
}

const MAX_FINDINGS = 8;

function dateRange(prep: Prepared): string {
    if (!Number.isFinite(prep.minTime)) return '';
    const f = (t: number) => new Date(t).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const a = f(prep.minTime), b = f(prep.maxTime);
    return a === b ? a : `${a} – ${b}`;
}

function dataNotes(prep: Prepared): string[] {
    const notes: string[] = [];
    const { focus } = prep;
    const last = prep.periods[prep.periods.length - 1];
    if (last && prep.partial.some(p => p.key === last.key)) {
        const through = new Date(prep.maxTime).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        notes.push(`${last.label} is incomplete (data runs to ${through}), so comparisons use ${prep.complete[prep.complete.length - 1]?.label || 'earlier periods'} as the latest ${focus.grain}.`);
    }
    const first = prep.periods[0];
    if (first && prep.periods.length > 1 && prep.partial.some(p => p.key === first.key)) {
        notes.push(`${first.label} is only partly covered, so it is left out of comparisons.`);
    }
    if (prep.undatedRows > 0 && focus.dateColumn) {
        const share = prep.undatedRows / Math.max(1, prep.rows.length);
        if (share >= 0.01) notes.push(`${Math.round(share * 100)}% of rows have no usable ${focus.dateColumn.replace(/_/g, ' ')} and are left out of time comparisons.`);
    }
    const columns = new Set<string>();
    for (const m of focus.metrics) for (const c of [m.column, m.numerator]) if (c) columns.add(c);
    for (const d of focus.dims) columns.add(d.column);
    for (const column of columns) {
        let missing = 0;
        for (const row of prep.rows) {
            const v = row?.[column];
            if (v === null || v === undefined || String(v).trim() === '') missing++;
        }
        const share = missing / Math.max(1, prep.rows.length);
        if (share >= 0.05) notes.push(`${Math.round(share * 100)}% of ${column.replace(/_/g, ' ')} values are missing; figures that use it cover the rest.`);
    }
    if (focus.metrics.some(m => m.kind === 'sum') === false) {
        notes.push(`No numeric measure was found, so the analysis counts ${focus.noun.many}.`);
    }
    return notes;
}

function pickKpis(prep: Prepared): AutoFinding[] {
    const out: AutoFinding[] = [];
    for (const metric of prep.focus.metrics) {
        if (out.length >= 4) break;
        const kpi = analyzeKpi(prep, metric.id);
        if (kpi) out.push(kpi);
    }
    return out;
}

function candidateFindings(prep: Prepared): AutoFinding[] {
    const { metrics } = prep.focus;
    const additive = metrics.filter(m => m.kind !== 'ratio');
    const ratios = metrics.filter(m => m.kind === 'ratio');
    const primary = additive[0];
    const found: (AutoFinding | null)[] = [];
    if (primary) {
        found.push(analyzeTrend(prep, primary.id));
        found.push(analyzeDrivers(prep, primary.id));
        found.push(analyzeConcentration(prep, primary.id));
        found.push(analyzeGrowth(prep, primary.id));
        found.push(analyzeWeekday(prep, primary.id));
        found.push(analyzeDistribution(prep, primary.id));
    }
    // A second additive metric (e.g. orders, profit) adds a trend of its own only
    // when it tells a different story from the primary.
    for (const metric of additive.slice(1, 3)) {
        const trend = analyzeTrend(prep, metric.id);
        const primaryTrend = found[0];
        if (trend && primaryTrend && trend.tone !== primaryTrend.tone && trend.tone !== 'neutral') found.push(trend);
        // Secondary metrics rank below the primary when they make the same point.
        const concentration = analyzeConcentration(prep, metric.id);
        if (concentration) found.push({ ...concentration, score: concentration.score - 10 });
    }
    for (const metric of ratios) {
        found.push(analyzeMix(prep, metric.id));
        found.push(analyzeSegmentRatio(prep, metric.id));
    }
    return found.filter((f): f is AutoFinding => Boolean(f));
}

/** Keep the strongest findings, at most one per analyser and breakdown pair. */
function rank(findings: AutoFinding[]): AutoFinding[] {
    const seen = new Set<string>();
    const out: AutoFinding[] = [];
    for (const f of [...findings].sort((a, b) => b.score - a.score)) {
        const key = `${f.analyzer}:${f.spec.dim || ''}:${f.spec.metricId}`;
        const sameShape = `${f.analyzer}:${f.spec.dim || ''}`;
        if (seen.has(key) || (f.analyzer === 'concentration' && seen.has(sameShape))) continue;
        seen.add(key);
        seen.add(sameShape);
        out.push(f);
        if (out.length >= MAX_FINDINGS) break;
    }
    // A trend reads best first: it sets the scene for the rest.
    const trendIndex = out.findIndex(f => f.analyzer === 'trend');
    if (trendIndex > 0) out.unshift(...out.splice(trendIndex, 1));
    return out;
}

function summarise(prep: Prepared, kpis: AutoFinding[], findings: AutoFinding[], notes: string[]): string[] {
    const sentences: string[] = [];
    if (kpis[0]) sentences.push(kpis[0].sentence);
    for (const f of findings.slice(0, 4)) sentences.push(f.sentence);
    const attention = findings.filter(f => f.tone === 'attention' || f.tone === 'bad').length;
    if (attention > 0 && findings.length > 4) {
        sentences.push(`${attention} of the ${findings.length} findings below need attention.`);
    }
    if (notes[0] && /incomplete/.test(notes[0])) sentences.push(notes[0]);
    if (sentences.length === 0) {
        sentences.push(`${prep.rows.length.toLocaleString('en-US')} ${prep.focus.noun.many} analysed; nothing stood out strongly enough to report.`);
    }
    return sentences;
}

/** Analyse a dataset and return the report. Pure: no network, no DuckDB. */
export function buildAutoReport(dataset: Dataset): AutoReport {
    const focus = chooseFocus(dataset);
    const prep = prepare(dataset.rows || [], focus);
    const kpis = pickKpis(prep);
    const findings = rank(candidateFindings(prep));
    const notes = dataNotes(prep);
    const range = dateRange(prep);
    const scope = [
        `${(dataset.rows?.length || 0).toLocaleString('en-US')} ${focus.noun.many}`,
        range,
        focus.grain ? `by ${focus.grain}` : '',
    ].filter(Boolean).join(' · ');
    return {
        datasetId: dataset.id,
        title: `${dataset.name || 'Dataset'} — Overview`,
        scope,
        summary: summarise(prep, kpis, findings, notes),
        kpis,
        findings,
        notes,
        focus,
        generatedAt: Date.now(),
    };
}

/**
 * Recompute one card from its spec against (possibly filtered) rows. Returns
 * null when the rows no longer support the finding (e.g. a filter left a
 * single category), so the caller can show an empty state.
 */
export function recomputeAutoCard(spec: AutoCardSpec, rows: Record<string, any>[]): AutoFinding | null {
    const prep = prepare(rows, spec.focus);
    const run = ANALYZERS[spec.analyzer];
    return run ? run(prep, spec.metricId, spec.dim) : null;
}

/**
 * A plain card title that describes what the card shows without quoting any
 * values (titles are synced to the cloud; findings with numbers stay local).
 */
export function cardTitle(finding: AutoFinding): string {
    const focus = finding.spec.focus;
    const metric = focus.metrics.find(m => m.id === finding.spec.metricId);
    const name = metric?.label || 'Value';
    const low = name.charAt(0).toLowerCase() + name.slice(1);
    const dim = focus.dims.find(d => d.column === finding.spec.dim);
    const by = dim ? ` by ${dim.label.charAt(0).toLowerCase()}${dim.label.slice(1)}` : '';
    const grain = focus.grain || 'period';
    switch (finding.analyzer) {
        case 'kpi': return name;
        case 'trend': return `${name} by ${grain}`;
        case 'drivers': return `What moved ${low} last ${grain}`;
        case 'mix': return `Why ${low} changed`;
        case 'concentration': return `${name}${by}`;
        case 'growth': return `Growth in ${low}${by}`;
        case 'segmentRatio': return `${name}${by}`;
        case 'weekday': return `${name} by day of week`;
        case 'distribution': return `${focus.noun.many.charAt(0).toUpperCase()}${focus.noun.many.slice(1)} by ${low}`;
        default: return name;
    }
}

/** Exposed for tests and the report UI. */
export function metricById(focus: Focus, id: string): MetricDef | undefined {
    return focus.metrics.find(m => m.id === id);
}

export { toNumber };
