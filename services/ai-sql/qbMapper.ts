/**
 * QB Mapper — AI SQL's primary compilation target.
 * ─────────────────────────────────────────────────────────────────────
 * Instead of asking the LLM to write SQL (an unbounded string space where
 * anything can go wrong), AI SQL first tries to express the user's question
 * as a **Question Builder configuration** — a finite, typed set of knobs
 * (aggregation, group-by, dimension/measure filters, sort, limit) that runs
 * through the same hardened deterministic engine the click-driven builder uses.
 *
 * This module maps a completed `AnalysisPlan` (already produced by the intent
 * planner) onto a `UIQueryConfig`. When every part of the plan lands on a real
 * builder knob → `fits: true` and the pipeline compiles it via buildQueryPlan
 * → compileSQL. When the question needs a shape the builder has no knob for
 * (period comparisons, share-of-total, above-average filters, two-stage
 * derived metrics, distributions, growth ranking, LIKE / NOT IN, composite
 * formula metrics), the mapper returns `fits: false` with a reason and the
 * pipeline falls back to the full AI SQL correction engine.
 *
 * The design principle: the unreliable component (the LLM) does the easy job
 * (intent → plan); the reliable deterministic code does the hard job (fit the
 * plan to a bounded DSL, or honestly refuse).
 */

import type { AnalysisPlan, PlanFilter, PlanMetric, SemanticModel } from './types';
import type { UIQueryConfig } from '../queryPlan/buildQueryPlan';
import { normalizeFilterOp, normalizeAgg } from './sqlCorrectionEngine';

export interface QBFit {
    fits: true;
    /** The Question Builder configuration that answers the question. */
    config: UIQueryConfig;
    /** The date column the builder should bucket/resolve time against. */
    dateColumnKey: string;
    /** When true, apply the builder's "% of total" table calculation to the base
     *  result (each group's value ÷ grand total). Mirrors how the click-driven
     *  builder computes share-of-total. */
    shareOfTotal?: boolean;
    /** Human-readable record of which knobs were set (explainability / trace). */
    notes: string[];
}

export interface QBNoFit {
    fits: false;
    /** Which knob is missing — surfaced in the trace and drives the fallback. */
    reason: string;
}

export type QBMapResult = QBFit | QBNoFit;

/** Intents whose whole shape lives inside the base builder query. Everything
 *  else (comparisons, share, derived, distribution, correlation, growth,
 *  aggregate-filter) is routed to the advanced engine. */
const FIT_INTENTS = new Set<AnalysisPlan['intent']>([
    'single_metric', 'breakdown', 'trend', 'ranking', 'share_of_total', 'aggregate_filter',
    'correlation', 'distribution',
]);

const AGG_MAP: Record<PlanMetric['agg'], string> = {
    sum: 'SUM', avg: 'AVG', count: 'COUNT', count_distinct: 'COUNT_DISTINCT', min: 'MIN', max: 'MAX',
};

/** Case-insensitive resolution of a plan field to a real dataset column. */
function resolveField(name: string, model: SemanticModel): string | null {
    if (!name) return null;
    const exact = model.fields.find(f => f.name === name);
    if (exact) return exact.name;
    const ci = model.fields.find(f => f.name.toLowerCase() === name.toLowerCase());
    return ci ? ci.name : null;
}

function fieldRole(name: string, model: SemanticModel): 'metric' | 'dimension' | 'date' | null {
    const f = model.fields.find(fl => fl.name.toLowerCase() === name.toLowerCase());
    if (!f) return null;
    if (f.physicalType === 'date' || f.semanticType === 'date') return 'date';
    return f.role;
}

const NUMERIC_OPS = new Set(['>', '<', '>=', '<=']);

/**
 * Attempt to express an AnalysisPlan as a Question Builder configuration.
 * Returns a fit (with the config) or a no-fit (with the reason).
 */
export function mapPlanToQBConfig(plan: AnalysisPlan, model: SemanticModel): QBMapResult {
    const notes: string[] = [];

    // ── Gate 1: intent must be a base-query shape ────────────────
    if (!FIT_INTENTS.has(plan.intent)) {
        return { fits: false, reason: `Intent "${plan.intent}" needs the advanced engine (comparison / share / derived / distribution / growth).` };
    }

    // ── Gate 2: no period comparison overlay ─────────────────────
    if (plan.comparison) {
        return { fits: false, reason: 'Period-over-period comparison is not a base builder knob.' };
    }

    // ── Distribution / histogram (special shape) ─────────────────
    // Bins one numeric column into buckets and counts rows per bucket.
    if (plan.intent === 'distribution') {
        const src = plan.metrics[0]?.field || plan.dimensions[0]?.field || '';
        const col = resolveField(src, model);
        if (!col) return { fits: false, reason: 'Distribution needs a numeric column that exists in the dataset.' };
        const f = model.fields.find(fl => fl.name === col);
        if (f && f.physicalType !== 'number') {
            return { fits: false, reason: `Distribution requires a numeric column ("${col}" is not numeric).` };
        }
        return {
            fits: true,
            config: { metric: col, aggregation: 'COUNT_ALL', distribution: { column: col, bins: 10 } },
            dateColumnKey: model.timeContext?.primaryDateColumn || '',
            notes: [`distribution of ${col} into 10 bins`],
        };
    }

    // ── Gate 3: metrics ──────────────────────────────────────────
    if (!plan.metrics || plan.metrics.length === 0) {
        return { fits: false, reason: 'No metric to aggregate.' };
    }
    for (const m of plan.metrics) {
        if (m.compositeId || m.derivedMetricId) {
            return { fits: false, reason: 'Composite / two-stage derived metrics are not expressible as a single builder aggregation.' };
        }
    }

    const primary = plan.metrics[0];
    let metricCol: string;
    let aggregation: string;

    if (primary.field === '*') {
        // COUNT(*) — the builder counts all rows; the column is a placeholder.
        aggregation = 'COUNT_ALL';
        metricCol = model.fields[0]?.name || 'id';
    } else {
        const resolved = resolveField(primary.field, model);
        if (!resolved) return { fits: false, reason: `Metric column "${primary.field}" not found in the dataset.` };
        metricCol = resolved;
        const pAgg = normalizeAgg(primary.agg) as PlanMetric['agg'];
        aggregation = pAgg === 'count' ? 'COUNT' : AGG_MAP[pAgg];
        if (!aggregation) return { fits: false, reason: `Aggregation "${primary.agg}" is not a builder option.` };
        // "median order value" → MEDIAN (the planner has no median agg, so detect
        // it from the question and override the numeric aggregation).
        if (/\bmedian\b/i.test(plan.originalQuestion || '') && aggregation !== 'COUNT' && aggregation !== 'COUNT_DISTINCT') {
            aggregation = 'MEDIAN';
        }
    }
    notes.push(`${aggregation} of ${metricCol}`);

    // Secondary metrics (plain columns only)
    const secondaryMetrics: string[] = [];
    const secondaryMetricAggregations: Record<string, string> = {};
    for (const m of plan.metrics.slice(1)) {
        const resolved = resolveField(m.field, model);
        if (!resolved) return { fits: false, reason: `Secondary metric column "${m.field}" not found.` };
        const sAgg = normalizeAgg(m.agg) as PlanMetric['agg'];
        secondaryMetrics.push(resolved);
        secondaryMetricAggregations[resolved] = sAgg === 'count' ? 'COUNT' : AGG_MAP[sAgg];
    }

    // ── Gate 4: dimensions ───────────────────────────────────────
    const timeDims = plan.dimensions.filter(d => d.timeGrain);
    const catDims = plan.dimensions.filter(d => !d.timeGrain);
    if (timeDims.length > 1) {
        return { fits: false, reason: 'Two time-bucketed dimensions are not expressible in a single builder query.' };
    }

    let dimension: string | undefined;
    let dateColumnKey = model.timeContext?.primaryDateColumn || '';
    const secondaryDimensions: string[] = [];
    const timeDimFields = new Set<string>();

    if (timeDims.length === 1) {
        const td = timeDims[0];
        const resolved = resolveField(td.field, model);
        if (!resolved) return { fits: false, reason: `Time dimension "${td.field}" not found.` };
        dimension = td.timeGrain; // the builder reads a grain string as the primary dimension
        dateColumnKey = resolved;
        timeDimFields.add(resolved.toLowerCase());
        notes.push(`grouped by ${td.timeGrain} of ${resolved}`);
        for (const d of catDims) {
            const r = resolveField(d.field, model);
            if (!r) return { fits: false, reason: `Dimension "${d.field}" not found.` };
            secondaryDimensions.push(r);
        }
    } else if (catDims.length > 0) {
        const first = resolveField(catDims[0].field, model);
        if (!first) return { fits: false, reason: `Dimension "${catDims[0].field}" not found.` };
        dimension = first;
        notes.push(`grouped by ${first}`);
        for (const d of catDims.slice(1)) {
            const r = resolveField(d.field, model);
            if (!r) return { fits: false, reason: `Dimension "${d.field}" not found.` };
            secondaryDimensions.push(r);
        }
    }
    const hasGrouping = !!dimension;

    // ── Gate 5: filters ──────────────────────────────────────────
    const inFilters: Record<string, string[]> = {};
    const excludeFilters: Record<string, string[]> = {};
    const measureFilters: Array<{ column: string; operator: string; value: number }> = [];
    const dateFilters: Array<{ column: string; timeGrain: string; values: string[] }> = [];
    const aggregateFilters: Array<{ column: string; op: '>' | '<' | '>=' | '<='; compareAgg: 'AVG'; compareColumn: string }> = [];
    const likeFilters: Array<{ column: string; pattern: string; negate?: boolean }> = [];
    let groupAvgHaving: { op: '>' | '<' | '>=' | '<='; metricIndex: number } | undefined;
    let timeFilter: string | undefined;

    for (const f of plan.filters) {
        // Normalize the LLM's operator spelling ("eq"→"=", "in_list"→"in", …) so
        // filters map to real builder knobs instead of silently no-fitting.
        const op = normalizeFilterOp(f.op);

        // Above / below the average of a raw column → row-level "vs aggregate"
        // filter (WHERE col > (SELECT AVG(col) FROM data)). A HAVING-style
        // grouped average (e.g. clients whose TOTAL exceeds the average total)
        // is a nested two-stage query → advanced engine.
        if (op === 'above_avg' || op === 'below_avg') {
            const col = resolveField(f.field, model);
            if (!col) return { fits: false, reason: `Above/below-average column "${f.field}" not found.` };
            const cmp = op === 'above_avg' ? '>' : '<';
            if (hasGrouping) {
                // Grouped: compare each group's aggregate to the average of the
                // group aggregates (nested HAVING). e.g. clients above the average client.
                groupAvgHaving = { op: cmp, metricIndex: 0 };
                notes.push(`having ${aggregation}(${metricCol}) ${cmp} the average across groups`);
            } else {
                // Row-level: WHERE col op (SELECT AVG(col) FROM data).
                aggregateFilters.push({ column: col, op: cmp, compareAgg: 'AVG', compareColumn: col });
                notes.push(`where ${col} ${cmp} average ${col}`);
            }
            continue;
        }

        if (op === '!=' || op === 'not_in') {
            const col = resolveField(f.field, model);
            if (!col) return { fits: false, reason: `Exclusion filter column "${f.field}" not found.` };
            const vals = op === 'not_in'
                ? (Array.isArray(f.value) ? f.value : [f.value]).map(v => String(v))
                : [String(f.value)];
            excludeFilters[col] = (excludeFilters[col] || []).concat(vals);
            notes.push(`where ${col} not in [${vals.join(', ')}]`);
            continue;
        }

        if (op === '=' || op === 'in') {
            const col = resolveField(f.field, model);
            if (!col) return { fits: false, reason: `Filter column "${f.field}" not found.` };
            const vals = op === 'in'
                ? (Array.isArray(f.value) ? f.value : [f.value]).map(v => String(v))
                : [String(f.value)];
            inFilters[col] = (inFilters[col] || []).concat(vals);
            notes.push(`where ${col} in [${vals.join(', ')}]`);
            continue;
        }

        if (op === 'between') {
            const col = resolveField(f.field, model);
            if (!col) return { fits: false, reason: `Filter column "${f.field}" not found.` };
            const role = fieldRole(f.field, model);
            if (role !== 'date') {
                return { fits: false, reason: `Numeric range (BETWEEN) on "${f.field}" is not a builder knob.` };
            }
            if (!Array.isArray(f.value) || f.value.length !== 2) {
                return { fits: false, reason: `Malformed date range on "${f.field}".` };
            }
            dateFilters.push({ column: col, timeGrain: 'day', values: [`${f.value[0]}__${f.value[1]}`] });
            notes.push(`where ${col} between ${f.value[0]} and ${f.value[1]}`);
            continue;
        }

        if (op.startsWith('this_')) {
            timeFilter = op; // resolved by buildQueryPlan against the dataset's date range
            notes.push(`where date is ${op.replace('this_', 'this ')}`);
            continue;
        }

        if (NUMERIC_OPS.has(op)) {
            // The builder's only numeric comparison is a post-aggregate HAVING on
            // the PRIMARY metric. It cannot express a row-level WHERE on a raw
            // number, nor a HAVING on a non-primary metric.
            const col = resolveField(f.field, model);
            const numVal = Number(f.value);
            if (!col || Number.isNaN(numVal)) {
                return { fits: false, reason: `Numeric filter on "${f.field}" is not expressible as a builder measure filter.` };
            }
            if (!hasGrouping || col !== metricCol) {
                return { fits: false, reason: `Filter "${f.field} ${op} ${f.value}" requires a shape the builder has no knob for.` };
            }
            measureFilters.push({ column: col, operator: op, value: numVal });
            notes.push(`having ${aggregation}(${col}) ${op} ${numVal}`);
            continue;
        }

        if (op === 'like') {
            const col = resolveField(f.field, model);
            if (!col) return { fits: false, reason: `Text filter column "${f.field}" not found.` };
            let pattern = String(f.value ?? '');
            if (!pattern.includes('%') && !pattern.includes('_')) pattern = `%${pattern}%`;
            likeFilters.push({ column: col, pattern });
            notes.push(`where ${col} like ${pattern}`);
            continue;
        }

        // Any residual operator — no builder knob.
        return { fits: false, reason: `Filter operator "${op}" is not a builder option.` };
    }

    // ── Sort ─────────────────────────────────────────────────────
    let sort: string | undefined;
    if (plan.sort && plan.sort.length > 0) {
        const s = plan.sort[0];
        const dir = /^(asc|ascending|up|increasing|rising|oldest|earliest|smallest|lowest|least)$/i.test(String(s.dir)) ? 'asc' : 'desc';
        if (timeDimFields.has(s.field.toLowerCase())) {
            sort = dir === 'asc' ? 'oldest' : 'newest';
        } else {
            sort = dir; // 'asc' | 'desc' → sort by primary metric
        }
    } else {
        // Sensible defaults matching the builder's own behaviour.
        if (plan.intent === 'trend' && timeDims.length === 1) sort = 'oldest';
        else sort = 'desc';
    }

    // ── Share of total → the builder's percent-of-total table calc ──
    // Only "share by <dimension>" is expressible (share of the group total).
    // A filtered scalar share ("what % of revenue is Beverages") is not — the
    // percent-of-total window would divide the filtered rows by their own sum
    // and yield 100%. Send that to the advanced engine instead.
    let shareOfTotal = false;
    if (plan.intent === 'share_of_total') {
        if (!hasGrouping) {
            return { fits: false, reason: 'A filtered scalar share needs the advanced engine (percent-of-total requires a group-by dimension).' };
        }
        shareOfTotal = true;
        notes.push('as percent of total');
    }

    const config: UIQueryConfig = {
        metric: metricCol,
        aggregation,
        dimension,
        timeFilter,
        filters: Object.keys(inFilters).length > 0 ? inFilters : undefined,
        excludeFilters: Object.keys(excludeFilters).length > 0 ? excludeFilters : undefined,
        measureFilters: measureFilters.length > 0 ? measureFilters : undefined,
        dateFilters: dateFilters.length > 0 ? dateFilters : undefined,
        aggregateFilters: aggregateFilters.length > 0 ? aggregateFilters : undefined,
        likeFilters: likeFilters.length > 0 ? likeFilters : undefined,
        groupAvgHaving,
        sort,
        limit: plan.limit || undefined,
        secondaryMetrics: secondaryMetrics.length > 0 ? secondaryMetrics : undefined,
        secondaryMetricAggregations: Object.keys(secondaryMetricAggregations).length > 0 ? secondaryMetricAggregations : undefined,
        secondaryDimensions: secondaryDimensions.length > 0 ? secondaryDimensions : undefined,
    };

    return { fits: true, config, dateColumnKey, shareOfTotal, notes };
}
