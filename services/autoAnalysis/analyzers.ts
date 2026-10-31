/**
 * Auto analysis — analysers.
 *
 * Each analyser looks at the prepared data from one angle and, when it finds
 * something worth saying, returns a finding: a headline with the numbers in
 * it, a short explanation, a chart that shows the evidence, and the spec
 * needed to recompute it later (on refresh or under dashboard filters).
 *
 * Analysers return null rather than a weak finding. Ranking happens in the
 * report; here each analyser scores its own result by how material it is.
 */

import type { QueryConfig } from '../../types';
import {
    type Acc, type DimInfo, type Focus, type MetricDef, type PeriodInfo, type Prepared,
    dimValue, fmt, fmtDelta, fmtPct, grainNoun, groupBy, isAdditive, lower, parts, valueOf,
} from './core';

// ───────────────────────────────────────────────────────────────────
// Output types
// ───────────────────────────────────────────────────────────────────

export type AnalyzerId = 'kpi' | 'trend' | 'drivers' | 'mix' | 'concentration' | 'growth' | 'segmentRatio' | 'weekday' | 'distribution';
export type Tone = 'good' | 'bad' | 'attention' | 'neutral';

export interface AutoCardSpec {
    v: 1;
    analyzer: AnalyzerId;
    metricId: string;
    dim?: string;
    focus: Focus;
}

export interface AutoCard {
    chartType: 'kpiCard' | 'area' | 'line' | 'bar' | 'horizontalBar' | 'doughnut' | 'treemap' | 'waterfall' | 'lollipop';
    data: Record<string, any>[];
    xKey: string;
    yKey: string;
    yLabel: string;
    numberFormat: 'auto' | 'raw' | 'currency_usd' | 'currency_eur' | 'percent_points' | 'compact';
    showDataLabels: boolean;
    width: 'full' | 'half';
    /** A Question Builder starting point for "Open in Builder". */
    builder?: Partial<QueryConfig>;
}

export interface AutoFinding {
    id: string;
    analyzer: AnalyzerId;
    /** Headline with the numbers in it. */
    title: string;
    /** One or two sentences of explanation. */
    detail: string;
    /** One sentence for the executive summary. */
    sentence: string;
    tone: Tone;
    score: number;
    card: AutoCard;
    spec: AutoCardSpec;
    /** A natural follow-up question. */
    question?: string;
}

// ───────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────

const metricOf = (prep: Prepared, id: string) => prep.focus.metrics.find(m => m.id === id);
const numberFormatOf = (m: MetricDef): AutoCard['numberFormat'] =>
    m.format === 'percent' ? 'percent_points' : m.format === 'currency_usd' ? 'currency_usd' : m.format === 'currency_eur' ? 'currency_eur' : 'auto';

function toneFor(metric: MetricDef, change: number): Tone {
    if (!Number.isFinite(change) || Math.abs(change) < 1e-9 || metric.higherIsBetter === null) return 'neutral';
    return (change > 0) === metric.higherIsBetter ? 'good' : 'bad';
}

/** Builder config for opening a card in the Question Builder. */
function builderFor(prep: Prepared, metric: MetricDef, dimension: string, extra: Partial<QueryConfig> = {}): Partial<QueryConfig> {
    const column = metric.kind === 'sum' ? metric.column : metric.kind === 'count' ? (metric.distinctColumn || '') : metric.numerator;
    const aggregation = metric.kind === 'sum' ? 'SUM' : metric.kind === 'count' ? (metric.distinctColumn ? 'COUNT_DISTINCT' : 'COUNT') : 'AVG';
    return {
        questionId: 'custom_builder',
        metric: column || '',
        dimension,
        aggregation: aggregation as any,
        timeGrain: 'Raw Date' as any,
        analysisType: 'Standard' as any,
        ...extra,
    };
}

function spec(prep: Prepared, analyzer: AnalyzerId, metric: MetricDef, dim?: string): AutoCardSpec {
    return { v: 1, analyzer, metricId: metric.id, ...(dim ? { dim } : {}), focus: prep.focus };
}

function totalIn(prep: Prepared, metric: MetricDef, keys: Set<string>): Acc | undefined {
    return groupBy(prep, metric, i => (keys.has(prep.periodOfRow[i]) ? 'all' : null)).get('all');
}

function byMember(prep: Prepared, metric: MetricDef, column: string, keys?: Set<string>): Map<string, Acc> {
    return groupBy(prep, metric, i => dimValue(prep.rows[i], column), keys ? i => keys.has(prep.periodOfRow[i]) : undefined);
}

/** Latest complete period and the complete period before it. */
export function latestPair(prep: Prepared): { cur: PeriodInfo; prev: PeriodInfo } | null {
    const c = prep.complete;
    if (c.length < 2) return null;
    return { cur: c[c.length - 1], prev: c[c.length - 2] };
}

function yearAgo(prep: Prepared, period: PeriodInfo): PeriodInfo | undefined {
    const grain = prep.focus.grain;
    const target = grain === 'month'
        ? `${Number(period.key.slice(0, 4)) - 1}${period.key.slice(4)}`
        : undefined;
    if (target) return prep.complete.find(p => p.key === target);
    const shifted = period.start - 364 * 86_400_000;
    return prep.complete.find(p => Math.abs(p.start - shifted) < 86_400_000 / 2);
}

export interface Windows { cur: Set<string>; prev: Set<string>; label: string; curLabel: string; prevLabel: string }

/** The most informative "recent vs comparable earlier" windows the data allows. */
export function compareWindows(prep: Prepared): Windows | null {
    const c = prep.complete;
    const keys = (list: PeriodInfo[]) => new Set(list.map(p => p.key));
    const span = (list: PeriodInfo[]) => list.length === 1 ? list[0].label : `${list[0].label} – ${list[list.length - 1].label}`;
    const g = prep.focus.grain;
    if (g === 'month') {
        if (c.length >= 24) {
            const cur = c.slice(-12), prev = c.slice(-24, -12);
            return { cur: keys(cur), prev: keys(prev), label: 'last 12 months vs the 12 before', curLabel: span(cur), prevLabel: span(prev) };
        }
        if (c.length >= 15) {
            const cur = c.slice(-3);
            const prev = cur.map(p => yearAgo(prep, p)).filter((p): p is PeriodInfo => Boolean(p));
            if (prev.length === 3) return { cur: keys(cur), prev: keys(prev), label: 'last 3 months vs a year earlier', curLabel: span(cur), prevLabel: span(prev) };
        }
        if (c.length >= 6) {
            const cur = c.slice(-3), prev = c.slice(-6, -3);
            return { cur: keys(cur), prev: keys(prev), label: 'last 3 months vs the 3 before', curLabel: span(cur), prevLabel: span(prev) };
        }
        return null;
    }
    const n = g === 'week' ? 4 : 7;
    if (c.length >= n * 2) {
        const cur = c.slice(-n), prev = c.slice(-2 * n, -n);
        const unit = g === 'week' ? 'weeks' : 'days';
        return { cur: keys(cur), prev: keys(prev), label: `last ${n} ${unit} vs the ${n} before`, curLabel: span(cur), prevLabel: span(prev) };
    }
    return null;
}

/** Recent scope for cross-sectional findings: last 12 months when available, else everything. */
function recentScope(prep: Prepared): { keys?: Set<string>; label: string } {
    if (prep.focus.grain === 'month' && prep.complete.length >= 12) {
        const last = prep.complete.slice(-12);
        return { keys: new Set(last.map(p => p.key)), label: 'over the last 12 months' };
    }
    return { label: prep.focus.grain ? 'across the whole period' : 'across all records' };
}

const dimsFor = (prep: Prepared, dim?: string): DimInfo[] =>
    dim ? prep.focus.dims.filter(d => d.column === dim) : prep.focus.dims;

const pluralDim = (d: DimInfo) => {
    const word = lower(d.label);
    return /s$/.test(word) ? word : /y$/.test(word) ? `${word.slice(0, -1)}ies` : `${word}s`;
};

const percent = (share: number) => `${Math.round(share * 100)}%`;

// ───────────────────────────────────────────────────────────────────
// KPI — the headline numbers
// ───────────────────────────────────────────────────────────────────

export function analyzeKpi(prep: Prepared, metricId: string): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric) return null;
    const pair = latestPair(prep);
    if (pair) {
        const cur = valueOf(totalIn(prep, metric, new Set([pair.cur.key])), metric);
        const prev = valueOf(totalIn(prep, metric, new Set([pair.prev.key])), metric);
        if (!Number.isFinite(cur)) return null;
        const ya = yearAgo(prep, pair.cur);
        const yoy = ya ? valueOf(totalIn(prep, metric, new Set([ya.key])), metric) : NaN;
        const change = Number.isFinite(prev) && prev !== 0 ? (cur - prev) / Math.abs(prev) : NaN;
        const yoyChange = Number.isFinite(yoy) && yoy !== 0 ? (cur - yoy) / Math.abs(yoy) : NaN;
        const deltaText = metric.format === 'percent' ? fmtDelta(cur - prev, metric) : fmtPct(change);
        const yoyText = ya && Number.isFinite(yoyChange)
            ? `, ${metric.format === 'percent' ? fmtDelta(cur - yoy, metric) : fmtPct(yoyChange)} on ${ya.label}` : '';
        return {
            id: `kpi:${metric.id}`, analyzer: 'kpi',
            title: metric.label,
            detail: `${fmt(cur, metric)} in ${pair.cur.label}${deltaText ? `, ${deltaText} vs ${pair.prev.label}` : ''}${yoyText}.`,
            sentence: `${metric.label} was ${fmt(cur, metric)} in ${pair.cur.label}${deltaText ? ` (${deltaText} vs ${pair.prev.label}${yoyText})` : ''}.`,
            tone: toneFor(metric, cur - prev), score: 0,
            card: {
                chartType: 'kpiCard', xKey: 'label', yKey: 'value', yLabel: `${metric.label} · ${pair.cur.label}`,
                data: [{ label: pair.cur.label, value: cur, ...(Number.isFinite(prev) ? { previous_value: prev, previous_label: pair.prev.label } : {}) }],
                numberFormat: numberFormatOf(metric), showDataLabels: false, width: 'half',
                builder: builderFor(prep, metric, ''),
            },
            spec: spec(prep, 'kpi', metric),
        };
    }
    const total = valueOf(groupBy(prep, metric, () => 'all').get('all'), metric);
    if (!Number.isFinite(total)) return null;
    return {
        id: `kpi:${metric.id}`, analyzer: 'kpi', title: metric.label,
        detail: `${fmt(total, metric)} across ${prep.rows.length.toLocaleString('en-US')} ${prep.focus.noun.many}.`,
        sentence: `${metric.label}: ${fmt(total, metric)}.`,
        tone: 'neutral', score: 0,
        card: {
            chartType: 'kpiCard', xKey: 'label', yKey: 'value', yLabel: metric.label,
            data: [{ label: 'All', value: total }], numberFormat: numberFormatOf(metric), showDataLabels: false, width: 'half',
            builder: builderFor(prep, metric, ''),
        },
        spec: spec(prep, 'kpi', metric),
    };
}

// ───────────────────────────────────────────────────────────────────
// Trend — where the metric is heading
// ───────────────────────────────────────────────────────────────────

export function analyzeTrend(prep: Prepared, metricId: string): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric || !prep.focus.grain || prep.complete.length < 3) return null;
    const byPeriod = groupBy(prep, metric, i => prep.periodOfRow[i] || null);
    const series = prep.complete.map(p => ({ period: p, value: valueOf(byPeriod.get(p.key), metric) }))
        .filter(point => Number.isFinite(point.value));
    if (series.length < 3) return null;
    const unit = grainNoun(prep.focus.grain);
    const best = series.reduce((a, b) => (b.value > a.value ? b : a));
    const worst = series.reduce((a, b) => (b.value < a.value ? b : a));

    const w = compareWindows(prep);
    let title: string, detail: string, sentence: string, tone: Tone = 'neutral', score = 30, change = NaN;
    if (w) {
        const cur = valueOf(totalIn(prep, metric, w.cur), metric);
        const prev = valueOf(totalIn(prep, metric, w.prev), metric);
        change = prev !== 0 ? (cur - prev) / Math.abs(prev) : NaN;
        const delta = metric.format === 'percent' ? cur - prev : change;
        const flat = metric.format === 'percent' ? Math.abs(cur - prev) < 0.5 : Math.abs(change) < 0.03;
        const moveText = metric.format === 'percent' ? fmtDelta(cur - prev, metric) : fmtPct(change);
        title = flat
            ? `${metric.label} has held steady (${moveText}, ${w.label})`
            : `${metric.label} is ${delta > 0 ? 'up' : 'down'} ${moveText.replace(/^[+−]/, '')} (${w.label})`;
        detail = `${fmt(cur, metric)} in ${w.curLabel} against ${fmt(prev, metric)} in ${w.prevLabel}. `
            + `${isAdditive(metric) ? 'Best' : 'Highest'} ${unit}: ${best.period.label} (${fmt(best.value, metric)}); `
            + `${isAdditive(metric) ? 'weakest' : 'lowest'}: ${worst.period.label} (${fmt(worst.value, metric)}).`;
        sentence = flat
            ? `${metric.label} has held steady (${moveText}, ${w.label}).`
            : `${metric.label} is ${delta > 0 ? 'up' : 'down'} ${moveText.replace(/^[+−]/, '')} (${w.label}).`;
        tone = flat ? 'neutral' : toneFor(metric, delta);
        score = 55 + Math.min(35, Math.abs(metric.format === 'percent' ? (cur - prev) * 3 : change * 100));
    } else {
        title = `${metric.label} by ${unit}: highest in ${best.period.label}`;
        detail = `${isAdditive(metric) ? 'Best' : 'Highest'} ${unit}: ${best.period.label} (${fmt(best.value, metric)}); lowest: ${worst.period.label} (${fmt(worst.value, metric)}).`;
        sentence = `${metric.label} peaked in ${best.period.label} at ${fmt(best.value, metric)}.`;
    }

    return {
        id: `trend:${metric.id}`, analyzer: 'trend', title, detail, sentence, tone, score,
        card: {
            chartType: isAdditive(metric) ? 'area' : 'line', xKey: 'period', yKey: 'value', yLabel: metric.label,
            data: series.map(point => ({ period: point.period.label, value: round(point.value) })),
            numberFormat: numberFormatOf(metric), showDataLabels: false, width: 'full',
            builder: builderFor(prep, metric, unit, { sort: 'oldest' as any }),
        },
        spec: spec(prep, 'trend', metric),
        question: `What drove the ${Number.isFinite(change) && change < 0 ? 'decline' : 'change'} in ${lower(metric.label)}?`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Drivers — which members moved an additive metric between two periods
// ───────────────────────────────────────────────────────────────────

export function analyzeDrivers(prep: Prepared, metricId: string, dim?: string, force = false): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    const pair = latestPair(prep);
    if (!metric || !isAdditive(metric) || !pair) return null;
    const curKeys = new Set([pair.cur.key]), prevKeys = new Set([pair.prev.key]);
    const curTotal = valueOf(totalIn(prep, metric, curKeys), metric);
    const prevTotal = valueOf(totalIn(prep, metric, prevKeys), metric);
    if (!(prevTotal > 0)) return null;

    let best: { dim: DimInfo; deltas: { label: string; delta: number }[]; top: number } | null = null;
    for (const d of dimsFor(prep, dim)) {
        const cur = byMember(prep, metric, d.column, curKeys);
        const prev = byMember(prep, metric, d.column, prevKeys);
        const labels = new Set([...cur.keys(), ...prev.keys()]);
        const deltas = [...labels].map(label => ({ label, delta: valueOf(cur.get(label), metric) - valueOf(prev.get(label), metric) }))
            .filter(x => Number.isFinite(x.delta))
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        const top = Math.abs(deltas[0]?.delta || 0);
        if (deltas.length >= 2 && (!best || top > best.top)) best = { dim: d, deltas, top };
    }
    if (!best) return null;

    const total = curTotal - prevTotal;
    const rel = total / prevTotal;
    if (!force && Math.abs(rel) < 0.03 && best.top / prevTotal < 0.05) return null; // nothing material moved

    const shown = best.deltas.slice(0, 5);
    const other = best.deltas.slice(5).reduce((sum, x) => sum + x.delta, 0);
    const steps = [...shown.map(x => ({ label: x.label, value: round(x.delta) })), ...(Math.abs(other) > 1e-9 ? [{ label: 'Other', value: round(other) }] : [])];
    const top = best.deltas[0];
    const dimWord = lower(best.dim.label);
    const flat = Math.abs(rel) < 0.03;
    const verb = total >= 0 ? 'rose' : 'fell';

    let title: string;
    if (flat) {
        const opposite = best.deltas.find(x => Math.sign(x.delta) !== Math.sign(top.delta));
        title = opposite
            ? `${metric.label} was flat in ${pair.cur.label}, but ${top.label} (${fmtDelta(top.delta, metric)}) and ${opposite.label} (${fmtDelta(opposite.delta, metric)}) moved apart`
            : `${metric.label} was flat in ${pair.cur.label}; ${top.label} moved most (${fmtDelta(top.delta, metric)})`;
    } else if (Math.sign(top.delta) === Math.sign(total) && Math.abs(top.delta) >= 0.5 * Math.abs(total)) {
        title = `${top.label} drove most of the ${total >= 0 ? 'rise' : 'drop'} in ${lower(metric.label)} (${fmtDelta(top.delta, metric)} of ${fmtDelta(total, metric)})`;
    } else {
        title = `${metric.label} ${verb} ${fmtPct(rel).replace(/^[+−]/, '')} in ${pair.cur.label}; ${top.label} moved most (${fmtDelta(top.delta, metric)})`;
    }
    const movers = best.deltas.slice(0, 3).map(x => `${x.label} ${fmtDelta(x.delta, metric)}`).join(', ');
    const detail = `${metric.label} went from ${fmt(prevTotal, metric)} in ${pair.prev.label} to ${fmt(curTotal, metric)} in ${pair.cur.label} (${fmtPct(rel)}). By ${dimWord}: ${movers}.`;

    return {
        id: `drivers:${metric.id}:${best.dim.column}`, analyzer: 'drivers', title, detail,
        sentence: flat
            ? `${metric.label} was flat in ${pair.cur.label}, but underneath it ${top.label} moved ${fmtDelta(top.delta, metric)}.`
            : `${metric.label} ${verb} ${fmtPct(rel).replace(/^[+−]/, '')} in ${pair.cur.label}, with ${top.label} the biggest mover (${fmtDelta(top.delta, metric)}).`,
        tone: flat ? 'neutral' : toneFor(metric, total),
        score: 72 + Math.min(25, Math.abs(rel) * 100),
        card: {
            chartType: 'waterfall', xKey: 'label', yKey: 'value', yLabel: `${metric.label}: ${pair.prev.label} → ${pair.cur.label}`,
            data: [
                { label: pair.prev.label, value: round(prevTotal), __kind: 'total' },
                ...steps,
                { label: pair.cur.label, value: round(curTotal), __kind: 'total' },
            ],
            numberFormat: numberFormatOf(metric), showDataLabels: true, width: 'full',
            builder: builderFor(prep, metric, best.dim.column, { comparison: 'previous_period' as any }),
        },
        spec: spec(prep, 'drivers', metric, best.dim.column),
        question: `Why did ${lower(metric.label)} for ${top.label} change in ${pair.cur.label}?`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Mix vs rate — why a ratio (average order value, margin) changed
// ───────────────────────────────────────────────────────────────────

export function analyzeMix(prep: Prepared, metricId: string, dim?: string, force = false): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric || metric.kind !== 'ratio') return null;
    const pair = latestPair(prep);
    const w = compareWindows(prep) || (pair ? {
        cur: new Set([pair.cur.key]), prev: new Set([pair.prev.key]),
        label: `${pair.cur.label} vs ${pair.prev.label}`, curLabel: pair.cur.label, prevLabel: pair.prev.label,
    } : null);
    if (!w) return null;
    const scale = metric.asPercent ? 100 : 1;

    const overall = (keys: Set<string>) => {
        const acc = totalIn(prep, metric, keys);
        return acc ? parts(acc, metric) : { num: 0, den: 0 };
    };
    const o0 = overall(w.prev), o1 = overall(w.cur);
    if (!(o0.den > 0) || !(o1.den > 0)) return null;
    const R0 = (o0.num / o0.den) * scale, R1 = (o1.num / o1.den) * scale;
    const change = R1 - R0;
    const material = metric.format === 'percent' ? Math.abs(change) >= 0.5 : Math.abs(change) / Math.abs(R0 || 1) >= 0.03;
    if (!material && !force) return null;

    let best: { dim: DimInfo; mix: number; rates: { label: string; effect: number; r0: number; r1: number; dw: number }[]; strength: number } | null = null;
    for (const d of dimsFor(prep, dim)) {
        const g0 = byMember(prep, metric, d.column, w.prev);
        const g1 = byMember(prep, metric, d.column, w.cur);
        let den0 = 0, den1 = 0;
        for (const acc of g0.values()) den0 += parts(acc, metric).den;
        for (const acc of g1.values()) den1 += parts(acc, metric).den;
        if (!(den0 > 0) || !(den1 > 0)) continue;
        let mix = 0;
        const rates: { label: string; effect: number; r0: number; r1: number; dw: number }[] = [];
        for (const label of new Set([...g0.keys(), ...g1.keys()])) {
            const p0 = g0.get(label) ? parts(g0.get(label)!, metric) : { num: 0, den: 0 };
            const p1 = g1.get(label) ? parts(g1.get(label)!, metric) : { num: 0, den: 0 };
            const w0 = p0.den / den0, w1 = p1.den / den1;
            const r1 = p1.den > 0 ? (p1.num / p1.den) * scale : NaN;
            const r0 = p0.den > 0 ? (p0.num / p0.den) * scale : r1;
            if (!Number.isFinite(r0)) continue;
            mix += (w1 - w0) * r0;
            if (p0.den > 0 && p1.den > 0) rates.push({ label, effect: w1 * (r1 - r0), r0, r1, dw: w1 - w0 });
            else rates.push({ label, effect: 0, r0, r1: Number.isFinite(r1) ? r1 : r0, dw: w1 - w0 });
        }
        rates.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
        const strength = Math.max(Math.abs(mix), Math.abs(rates[0]?.effect || 0));
        if (rates.length >= 2 && (!best || strength > best.strength)) best = { dim: d, mix, rates, strength };
    }
    if (!best) return null;

    const rateTotal = best.rates.reduce((s, r) => s + r.effect, 0);
    const mixLed = Math.abs(best.mix) >= Math.abs(rateTotal);
    const dimWord = lower(best.dim.label);
    const moveText = metric.format === 'percent' ? fmtDelta(change, metric) : fmtPct(change / Math.abs(R0));
    const up = change > 0;
    let reason: string;
    if (mixLed) {
        // Which member gained or lost the most weight, and is it above or below average?
        const shifter = [...best.rates].sort((a, b) => Math.abs(b.dw) - Math.abs(a.dw))[0];
        const moreOrLess = shifter.dw > 0 ? 'more' : 'less';
        const aboveBelow = shifter.r0 >= R0 ? 'above' : 'below';
        reason = `mostly a shift in mix: ${moreOrLess} came from ${shifter.label}, which runs ${aboveBelow} average (${fmt(shifter.r0, metric)})`;
    } else {
        const lead = best.rates[0];
        reason = `mostly within ${lead.label}, which went from ${fmt(lead.r0, metric)} to ${fmt(lead.r1, metric)}`;
    }
    const title = `${metric.label} ${up ? 'rose' : 'fell'} ${moveText.replace(/^[+−]/, '')}: ${reason}`;
    const detail = `${metric.label} went from ${fmt(R0, metric)} (${w.prevLabel}) to ${fmt(R1, metric)} (${w.curLabel}). `
        + `Change in the ${dimWord} mix: ${fmtDelta(best.mix, metric)}; changes within each ${dimWord}: ${fmtDelta(rateTotal, metric)}.`;

    const shown = best.rates.slice(0, 5);
    const data = [
        { label: `Mix of ${pluralDim(best.dim)}`, value: round(best.mix) },
        ...shown.map(r => ({ label: `Within ${r.label}`, value: round(r.effect) })),
    ];
    return {
        id: `mix:${metric.id}:${best.dim.column}`, analyzer: 'mix', title, detail,
        sentence: `${metric.label} ${up ? 'rose' : 'fell'} ${moveText.replace(/^[+−]/, '')} (${w.label}), ${reason}.`,
        tone: toneFor(metric, change), score: 68 + Math.min(20, Math.abs(change / Math.abs(R0 || 1)) * 100),
        card: {
            chartType: 'horizontalBar', xKey: 'label', yKey: 'value', yLabel: `What moved ${lower(metric.label)} (${w.label})`,
            data, numberFormat: numberFormatOf(metric), showDataLabels: true, width: 'half',
            builder: builderFor(prep, metric, best.dim.column),
        },
        spec: spec(prep, 'mix', metric, best.dim.column),
        question: `How has the ${dimWord} mix changed?`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Concentration — how much depends on a few members
// ───────────────────────────────────────────────────────────────────

export function analyzeConcentration(prep: Prepared, metricId: string, dim?: string): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric || !isAdditive(metric)) return null;
    const scope = recentScope(prep);
    let best: { dim: DimInfo; members: { label: string; value: number }[]; total: number; topShare: number; k80: number; strength: number } | null = null;
    for (const d of dimsFor(prep, dim)) {
        const groups = byMember(prep, metric, d.column, scope.keys);
        const members = [...groups.entries()].map(([label, acc]) => ({ label, value: valueOf(acc, metric) }))
            .filter(m => Number.isFinite(m.value)).sort((a, b) => b.value - a.value);
        if (members.length < 3 || members.some(m => m.value < 0)) continue;
        const total = members.reduce((s, m) => s + m.value, 0);
        if (!(total > 0)) continue;
        const topShare = members[0].value / total;
        let run = 0, k80 = 0;
        for (const m of members) { run += m.value; k80++; if (run / total >= 0.8) break; }
        // A dominant member, or a few members carrying a long list.
        const strength = members.length <= 12 ? topShare * (1 - 1 / members.length) : (1 - k80 / members.length);
        if (!best || strength > best.strength) best = { dim: d, members, total, topShare, k80, strength };
    }
    if (!best) return null;
    const { members, total, topShare, k80 } = best;
    const n = members.length;
    const dimWord = lower(best.dim.label);
    const top = members[0];
    let title: string, sentence: string, tone: Tone = 'neutral', score: number;
    if (topShare >= 0.35) {
        const restCombined = topShare > 0.5 ? ' — more than all the others combined' : '';
        title = `${top.label} accounts for ${percent(topShare)} of ${lower(metric.label)}${restCombined}`;
        sentence = `${top.label} accounts for ${percent(topShare)} of ${lower(metric.label)} ${scope.label}${topShare >= 0.5 ? ', a dependency worth watching' : ''}.`;
        tone = topShare >= 0.5 ? 'attention' : 'neutral';
        score = 45 + topShare * 40;
    } else if (n >= 8 && k80 / n <= 0.4) {
        title = `${k80} of ${n} ${pluralDim(best.dim)} make up 80% of ${lower(metric.label)}`;
        sentence = `Just ${k80} of ${n} ${pluralDim(best.dim)} make up 80% of ${lower(metric.label)} ${scope.label}.`;
        score = 45 + (1 - k80 / n) * 30;
    } else {
        title = `${metric.label} is spread across ${n} ${pluralDim(best.dim)}; ${top.label} leads with ${percent(topShare)}`;
        sentence = `${metric.label} is spread fairly evenly across ${pluralDim(best.dim)} (largest: ${top.label}, ${percent(topShare)}).`;
        score = 25;
    }
    const detail = `${scope.label.charAt(0).toUpperCase()}${scope.label.slice(1)}: ${members.slice(0, 3).map(m => `${m.label} ${fmt(m.value, metric)} (${percent(m.value / total)})`).join(', ')}${n > 3 ? `, and ${n - 3} more` : ''}.`;

    const chartType: AutoCard['chartType'] = n <= 6 ? 'doughnut' : n <= 15 ? 'horizontalBar' : 'treemap';
    const capped = n > 20 ? [...members.slice(0, 19), { label: 'Other', value: members.slice(19).reduce((s, m) => s + m.value, 0) }] : members;
    return {
        id: `concentration:${metric.id}:${best.dim.column}`, analyzer: 'concentration', title, detail, sentence, tone, score,
        card: {
            chartType, xKey: 'label', yKey: 'value', yLabel: `${metric.label} by ${dimWord}`,
            data: capped.map(m => ({ label: m.label, value: round(m.value) })),
            numberFormat: numberFormatOf(metric), showDataLabels: n <= 10, width: 'half',
            builder: builderFor(prep, metric, best.dim.column, { sort: 'desc' as any }),
        },
        spec: spec(prep, 'concentration', metric, best.dim.column),
        question: `How has ${lower(metric.label)} from ${top.label} changed over time?`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Growth — which members are growing and shrinking
// ───────────────────────────────────────────────────────────────────

export function analyzeGrowth(prep: Prepared, metricId: string, dim?: string, force = false): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    const w = compareWindows(prep);
    if (!metric || !isAdditive(metric) || !w) return null;
    let best: { dim: DimInfo; rows: { label: string; growth: number; cur: number; prev: number }[]; spread: number } | null = null;
    for (const d of dimsFor(prep, dim)) {
        const g0 = byMember(prep, metric, d.column, w.prev);
        const g1 = byMember(prep, metric, d.column, w.cur);
        const volume = [...g0.values(), ...g1.values()].reduce((s, a) => s + Math.max(0, valueOf(a, metric)), 0);
        if (!(volume > 0)) continue;
        const rows = [...new Set([...g0.keys(), ...g1.keys()])].map(label => {
            const prev = valueOf(g0.get(label), metric), cur = valueOf(g1.get(label), metric);
            return { label, prev, cur, growth: prev > 0 ? (cur - prev) / prev : NaN };
        }).filter(r => Number.isFinite(r.growth) && (r.prev + r.cur) / volume >= 0.03);
        if (rows.length < 3) continue;
        rows.sort((a, b) => b.growth - a.growth);
        const spread = rows[0].growth - rows[rows.length - 1].growth;
        if ((force || spread >= 0.1) && (!best || spread > best.spread)) best = { dim: d, rows, spread };
    }
    if (!best) return null;
    const hi = best.rows[0], lo = best.rows[best.rows.length - 1];
    const dimWord = lower(best.dim.label);
    let title: string;
    if (hi.growth > 0 && lo.growth < 0) title = `${hi.label} is growing fastest (${fmtPct(hi.growth)}); ${lo.label} is shrinking (${fmtPct(lo.growth)})`;
    else if (hi.growth > 0) title = `${hi.label} is growing fastest (${fmtPct(hi.growth)}); ${lo.label} slowest (${fmtPct(lo.growth)})`;
    else title = `Every ${dimWord} is down; ${lo.label} fell most (${fmtPct(lo.growth)})`;
    return {
        id: `growth:${metric.id}:${best.dim.column}`, analyzer: 'growth', title,
        detail: `${metric.label} by ${dimWord}, ${w.label}. ${hi.label}: ${fmt(hi.prev, metric)} → ${fmt(hi.cur, metric)}; ${lo.label}: ${fmt(lo.prev, metric)} → ${fmt(lo.cur, metric)}.`,
        sentence: hi.growth > 0 && lo.growth < 0
            ? `By ${dimWord}, ${hi.label} is growing fastest (${fmtPct(hi.growth)}) while ${lo.label} is shrinking (${fmtPct(lo.growth)}).`
            : `By ${dimWord}, growth ranges from ${fmtPct(hi.growth)} (${hi.label}) to ${fmtPct(lo.growth)} (${lo.label}).`,
        tone: lo.growth < -0.1 ? 'attention' : 'neutral',
        score: 55 + Math.min(30, best.spread * 40),
        card: {
            chartType: 'horizontalBar', xKey: 'label', yKey: 'value', yLabel: `${metric.label} growth by ${dimWord} (${w.label})`,
            data: best.rows.map(r => ({ label: r.label, value: Math.round(r.growth * 1000) / 10 })),
            numberFormat: 'percent_points', showDataLabels: true, width: 'half',
            builder: builderFor(prep, metric, best.dim.column),
        },
        spec: spec(prep, 'growth', metric, best.dim.column),
        question: `What is driving growth in ${hi.label}?`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Segment ratio — which member's average or margin stands apart
// ───────────────────────────────────────────────────────────────────

export function analyzeSegmentRatio(prep: Prepared, metricId: string, dim?: string, force = false): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric || metric.kind !== 'ratio') return null;
    const scope = recentScope(prep);
    const overallAcc = scope.keys ? totalIn(prep, metric, scope.keys) : groupBy(prep, metric, () => 'all').get('all');
    const R = valueOf(overallAcc, metric);
    if (!Number.isFinite(R)) return null;
    let best: { dim: DimInfo; rows: { label: string; value: number; weight: number }[]; pick: { label: string; value: number }; gap: number } | null = null;
    for (const d of dimsFor(prep, dim)) {
        const groups = byMember(prep, metric, d.column, scope.keys);
        let denTotal = 0;
        for (const acc of groups.values()) denTotal += parts(acc, metric).den;
        if (!(denTotal > 0)) continue;
        const rows = [...groups.entries()].map(([label, acc]) => ({ label, value: valueOf(acc, metric), weight: parts(acc, metric).den / denTotal }))
            .filter(r => Number.isFinite(r.value) && r.weight >= 0.05);
        if (rows.length < 3) continue;
        const pick = rows.reduce((a, b) => (Math.abs(b.value - R) > Math.abs(a.value - R) ? b : a));
        const gap = metric.format === 'percent' ? Math.abs(pick.value - R) / 10 : Math.abs(pick.value - R) / Math.abs(R || 1);
        if ((force || (metric.format === 'percent' ? Math.abs(pick.value - R) >= 2 : gap >= 0.15)) && (!best || gap > best.gap)) {
            best = { dim: d, rows: rows.sort((a, b) => b.value - a.value), pick, gap };
        }
    }
    if (!best) return null;
    const above = best.pick.value > R;
    const dimWord = lower(best.dim.label);
    const word = above ? 'highest' : 'lowest';
    const title = `${best.pick.label} has the ${word} ${lower(metric.label)}: ${fmt(best.pick.value, metric)} vs ${fmt(R, metric)} overall`;
    const bad = metric.higherIsBetter !== null && above !== metric.higherIsBetter;
    return {
        id: `segmentRatio:${metric.id}:${best.dim.column}`, analyzer: 'segmentRatio', title,
        detail: `${metric.label} by ${dimWord} ${scope.label}, for ${pluralDim(best.dim)} with at least 5% of the volume. Range: ${fmt(best.rows[0].value, metric)} (${best.rows[0].label}) to ${fmt(best.rows[best.rows.length - 1].value, metric)} (${best.rows[best.rows.length - 1].label}).`,
        sentence: `${best.pick.label} stands out with ${fmt(best.pick.value, metric)} ${lower(metric.label)} against ${fmt(R, metric)} overall.`,
        tone: bad ? 'attention' : 'neutral',
        score: 50 + Math.min(30, best.gap * 50),
        card: {
            chartType: best.rows.length > 6 ? 'lollipop' : 'horizontalBar', xKey: 'label', yKey: 'value',
            yLabel: `${metric.label} by ${dimWord} (overall ${fmt(R, metric)})`,
            data: best.rows.map(r => ({ label: r.label, value: round(r.value) })),
            numberFormat: numberFormatOf(metric), showDataLabels: true, width: 'half',
            builder: builderFor(prep, metric, best.dim.column, { sort: 'desc' as any }),
        },
        spec: spec(prep, 'segmentRatio', metric, best.dim.column),
        question: `Why is ${lower(metric.label)} ${above ? 'higher' : 'lower'} for ${best.pick.label}?`,
    };
}

// ───────────────────────────────────────────────────────────────────
// Weekday pattern
// ───────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export function analyzeWeekday(prep: Prepared, metricId: string, force = false): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric || !isAdditive(metric) || !Number.isFinite(prep.minTime)) return null;
    const DAY = 86_400_000;
    const days = new Set<number>();
    for (const t of prep.timeOfRow) if (Number.isFinite(t)) days.add(Math.floor(t / DAY));
    const firstDay = Math.floor(prep.minTime / DAY), lastDay = Math.floor(prep.maxTime / DAY);
    const spanDays = lastDay - firstDay + 1;
    // Needs genuinely daily data: many distinct dates covering most of the range.
    if (spanDays < 28 || days.size < 28 || days.size < spanDays * 0.5) return null;
    const totals = new Array(7).fill(0);
    const groups = groupBy(prep, metric, i => {
        const t = prep.timeOfRow[i];
        return Number.isFinite(t) ? String((new Date(t).getUTCDay() + 6) % 7) : null;
    });
    for (const [k, acc] of groups) totals[Number(k)] = valueOf(acc, metric);
    const counts = new Array(7).fill(0);
    for (let d = firstDay; d <= lastDay; d++) counts[(new Date(d * DAY).getUTCDay() + 6) % 7]++;
    const perDay = totals.map((t, i) => (counts[i] > 0 ? t / counts[i] : 0));
    const avg = totals.reduce((a, b) => a + b, 0) / spanDays;
    if (!(avg > 0)) return null;
    const hi = perDay.indexOf(Math.max(...perDay)), lo = perDay.indexOf(Math.min(...perDay));
    const hiDev = perDay[hi] / avg - 1, loDev = perDay[lo] / avg - 1;
    if (!force && Math.max(hiDev, -loDev) < 0.1) return null;
    return {
        id: `weekday:${metric.id}`, analyzer: 'weekday',
        title: `${WEEKDAYS[hi]}s are the strongest day: ${percent(hiDev)} above an average day`,
        detail: `Average ${lower(metric.label)} per calendar day: ${WEEKDAYS[hi]} ${fmt(perDay[hi], metric)}, ${WEEKDAYS[lo]} ${fmt(perDay[lo], metric)} (${fmtPct(loDev)} vs average).`,
        sentence: `${WEEKDAYS[hi]}s bring ${percent(hiDev)} more ${lower(metric.label)} than an average day; ${WEEKDAYS[lo]}s ${percent(-loDev)} less.`,
        tone: 'neutral', score: 35 + Math.min(30, Math.max(hiDev, -loDev) * 60),
        card: {
            chartType: 'bar', xKey: 'day', yKey: 'value', yLabel: `Average ${lower(metric.label)} per day`,
            data: WEEKDAYS.map((name, i) => ({ day: name.slice(0, 3), value: round(perDay[i]) })),
            numberFormat: numberFormatOf(metric), showDataLabels: true, width: 'half',
        },
        spec: spec(prep, 'weekday', metric),
    };
}

// ───────────────────────────────────────────────────────────────────
// Distribution — how value is spread across records
// ───────────────────────────────────────────────────────────────────

export function analyzeDistribution(prep: Prepared, metricId: string, force = false): AutoFinding | null {
    const metric = metricOf(prep, metricId);
    if (!metric || metric.kind !== 'sum') return null;
    const { entityColumn, noun } = prep.focus;
    const perEntity = groupBy(prep, metric, i => (entityColumn ? dimValue(prep.rows[i], entityColumn) : String(i)));
    const values = [...perEntity.values()].map(acc => valueOf(acc, metric)).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => b - a);
    const n = values.length;
    if (n < 30) return null;
    const total = values.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    const topN = Math.max(1, Math.ceil(n * 0.1));
    const topShare = values.slice(0, topN).reduce((a, b) => a + b, 0) / total;
    if (!force && topShare < 0.2) return null;
    const asc = [...values].reverse();
    const median = asc[Math.floor((n - 1) / 2)];
    const mean = total / n;
    const p95 = asc[Math.floor((n - 1) * 0.95)];
    const step = niceStep(p95 / 8);
    const bins = Math.max(1, Math.min(12, Math.ceil(p95 / step)));
    const counts = new Array(bins + 1).fill(0);
    for (const v of values) counts[Math.min(bins, Math.floor(v / step))]++;
    const label = (lo: number, hi?: number) => hi === undefined ? `${fmt(lo, metric)}+` : `${fmt(lo, metric)}–${fmt(hi, metric)}`;
    const data = counts.map((count, i) => ({ band: i === bins ? label(i * step) : label(i * step, (i + 1) * step), value: count }))
        .filter((row, i) => i < bins || row.value > 0);
    return {
        id: `distribution:${metric.id}`, analyzer: 'distribution',
        title: `The top 10% of ${noun.many} bring in ${percent(topShare)} of ${lower(metric.label)}`,
        detail: `A typical ${noun.one} is ${fmt(median, metric)} (median); the average is ${fmt(mean, metric)}${mean > median * 1.2 ? `, pulled up by a minority of large ${noun.many}` : ''}.`,
        sentence: `The top 10% of ${noun.many} bring in ${percent(topShare)} of ${lower(metric.label)}; a typical ${noun.one} is ${fmt(median, metric)}.`,
        tone: 'neutral', score: 30 + Math.min(30, (topShare - 0.1) * 60),
        card: {
            chartType: 'bar', xKey: 'band', yKey: 'value', yLabel: `${humanizeCount(noun.many)} by ${lower(metric.label)}`,
            data, numberFormat: 'raw', showDataLabels: bins <= 10, width: 'half',
        },
        spec: spec(prep, 'distribution', metric),
    };
}

const humanizeCount = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

function niceStep(raw: number): number {
    if (!(raw > 0)) return 1;
    const power = 10 ** Math.floor(Math.log10(raw));
    const m = raw / power;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * power;
}

function round(value: number): number {
    if (!Number.isFinite(value)) return value;
    const abs = Math.abs(value);
    return abs >= 100 ? Math.round(value * 100) / 100 : Math.round(value * 10000) / 10000;
}

/** Every analyser, run with `force` so a recomputed card still draws when its change is small. */
export const ANALYZERS: Record<AnalyzerId, (prep: Prepared, metricId: string, dim?: string) => AutoFinding | null> = {
    kpi: (p, m) => analyzeKpi(p, m),
    trend: (p, m) => analyzeTrend(p, m),
    drivers: (p, m, d) => analyzeDrivers(p, m, d, true),
    mix: (p, m, d) => analyzeMix(p, m, d, true),
    concentration: (p, m, d) => analyzeConcentration(p, m, d),
    growth: (p, m, d) => analyzeGrowth(p, m, d, true),
    segmentRatio: (p, m, d) => analyzeSegmentRatio(p, m, d, true),
    weekday: (p, m) => analyzeWeekday(p, m, true),
    distribution: (p, m) => analyzeDistribution(p, m, true),
};
