/**
 * Parameters (admin-only) — the deterministic query engine, made visible.
 *
 * AI SQL answers a question by first mapping it onto the Question Builder's
 * finite, typed knob set and running the hardened deterministic engine. Only
 * when a question needs a shape the builder has no knob for does it fall back to
 * the LLM SQL path. This page documents that knob set (so admins can see exactly
 * what runs deterministically) and demonstrates the mapping live, in-browser,
 * with no API call.
 */
import React, { useMemo, useState } from 'react';
import { SlidersHorizontal, CheckCircle2, CircleDashed, Cpu, Play } from 'lucide-react';
import {
    DETERMINISTIC_KNOBS, AI_ROUTED_SHAPES, DETERMINISTIC_COUNT, AI_ROUTED_COUNT,
    type KnobDoc,
} from '../services/ai-sql/qbKnobCatalog';
import { mapPlanToQBConfig } from '../services/ai-sql/qbMapper';
import { buildQueryPlan } from '../services/queryPlan/buildQueryPlan';
import { compileSQL } from '../services/queryPlan/sqlCompiler';
import { getDates } from '../services/dateHelpers';
import type { AnalysisPlan, SemanticField, SemanticModel } from '../services/ai-sql/types';

// ── A lightweight demo model (a retail-orders shape) so the live mapping runs
//    without a loaded dataset. The mapper only reads field name/role/type. ──
const demoField = (name: string, role: 'metric' | 'dimension', physicalType: 'number' | 'string' | 'date'): SemanticField => ({
    name, role, physicalType,
    semanticType: physicalType === 'date' ? 'date' : role === 'metric' ? 'currency' : 'category',
    defaultAgg: role === 'metric' ? 'sum' : 'none',
    timeGrainSupport: physicalType === 'date' ? ['day', 'week', 'month', 'quarter', 'year'] : [],
    synonyms: [], valueDescriptors: [], distinctCount: 10, hasNulls: false,
    displayLabel: name,
});

const DEMO_MODEL: SemanticModel = {
    fields: [
        demoField('order_id', 'dimension', 'number'),
        demoField('customer_id', 'dimension', 'string'),
        demoField('channel', 'dimension', 'string'),
        demoField('category', 'dimension', 'string'),
        demoField('product', 'dimension', 'string'),
        demoField('quantity', 'metric', 'number'),
        demoField('total_price', 'metric', 'number'),
        demoField('order_date', 'dimension', 'date'),
    ],
    compositeMetrics: [], derivedMetrics: [], datasetName: 'orders', rowCount: 100,
    timeContext: { anchorDate: '2025-06-30', minDate: '2025-01-01', maxDate: '2025-06-30', primaryDateColumn: 'order_date' },
    grain: 'order',
};

const P = (o: Partial<AnalysisPlan>): AnalysisPlan => ({
    intent: 'breakdown', dimensions: [], metrics: [], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: '', originalQuestion: '', ...o,
});

/** Example questions with the plan the intent planner would produce. */
const DEMO_QUESTIONS: Array<{ q: string; plan: AnalysisPlan }> = [
    { q: 'What is the total revenue?', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }] }) },
    { q: 'How many distinct customers ordered via Delivery?', plan: P({ intent: 'single_metric', metrics: [{ field: 'customer_id', agg: 'count_distinct' }], filters: [{ field: 'channel', op: '=', value: 'Delivery' }] }) },
    { q: 'Revenue by channel', plan: P({ intent: 'breakdown', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }] }) },
    { q: 'Top 5 products by revenue', plan: P({ intent: 'ranking', dimensions: [{ field: 'product' }], metrics: [{ field: 'total_price', agg: 'sum' }], sort: [{ field: 'total_price', dir: 'desc' }], limit: 5 }) },
    { q: 'Revenue excluding Online orders', plan: P({ intent: 'single_metric', metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'channel', op: '!=', value: 'Online' }] }) },
    { q: 'How many orders are above the average order value?', plan: P({ intent: 'aggregate_filter', metrics: [{ field: '*', agg: 'count' }], filters: [{ field: 'total_price', op: 'above_avg', value: null }] }) },
    { q: 'What share of revenue does each channel represent?', plan: P({ intent: 'share_of_total', dimensions: [{ field: 'channel' }], metrics: [{ field: 'total_price', agg: 'sum' }] }) },
    { q: 'Revenue by month', plan: P({ intent: 'trend', dimensions: [{ field: 'order_date', timeGrain: 'month' }], metrics: [{ field: 'total_price', agg: 'sum' }] }) },
    { q: 'Revenue this month vs last month', plan: P({ intent: 'total_comparison', metrics: [{ field: 'total_price', agg: 'sum' }], comparison: { type: 'previous_period', mode: 'total' } }) },
    { q: 'Average daily sales', plan: P({ intent: 'derived_metric', metrics: [{ field: 'total_price', agg: 'avg', derivedMetricId: 'avg_daily' }] }) },
    { q: 'Products whose name contains "Pro"', plan: P({ intent: 'breakdown', dimensions: [{ field: 'product' }], metrics: [{ field: 'total_price', agg: 'sum' }], filters: [{ field: 'product', op: 'like', value: '%Pro%' }] }) },
];

function mapDemo(plan: AnalysisPlan): { deterministic: boolean; detail: string; sql?: string } {
    const res = mapPlanToQBConfig(plan, DEMO_MODEL);
    if (!res.fits) return { deterministic: false, detail: (res as { reason?: string }).reason || 'routed to AI' };
    try {
        const qp = buildQueryPlan(res.config, res.dateColumnKey, getDates('2025-06-30'), 'data');
        return { deterministic: true, detail: res.notes.join('; '), sql: compileSQL(qp) };
    } catch {
        return { deterministic: false, detail: 'compilation failed' };
    }
}

const GROUPS: KnobDoc['group'][] = ['Aggregation', 'Group-by', 'Filter', 'Shape', 'Ordering'];

export const ParametersView: React.FC = () => {
    const [open, setOpen] = useState<number | null>(0);
    const demo = useMemo(() => DEMO_QUESTIONS.map(d => ({ ...d, result: mapDemo(d.plan) })), []);
    const detCount = demo.filter(d => d.result.deterministic).length;

    return (
        <div className="h-full overflow-y-auto px-6 py-6 max-w-5xl mx-auto">
            {/* Header */}
            <div className="flex items-center gap-3 mb-2">
                <SlidersHorizontal className="w-6 h-6 text-indigo-500" />
                <h1 className="text-xl font-extrabold text-gray-900 dark:text-white">Parameters</h1>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300">ADMIN</span>
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-6 max-w-3xl">
                AI SQL answers a question by mapping it onto the Question Builder's finite, typed knob set and
                running the hardened deterministic engine — the same one users drive by clicking. It falls back to
                the LLM only when a question needs a shape no knob covers. This page is the map of that knob set.
            </p>

            {/* Coverage tiles */}
            <div className="grid grid-cols-3 gap-3 mb-8">
                <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] p-4">
                    <div className="text-2xl font-extrabold text-emerald-600 dark:text-emerald-400">{DETERMINISTIC_COUNT}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">deterministic knobs</div>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] p-4">
                    <div className="text-2xl font-extrabold text-gray-500 dark:text-gray-300">{AI_ROUTED_COUNT}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">shapes routed to AI</div>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] p-4">
                    <div className="text-2xl font-extrabold text-indigo-600 dark:text-indigo-400">{detCount}/{demo.length}</div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">sample questions deterministic</div>
                </div>
            </div>

            {/* Live mapping demo */}
            <div className="flex items-center gap-2 mb-3">
                <Play className="w-4 h-4 text-indigo-500" />
                <h2 className="text-sm font-extrabold text-gray-900 dark:text-white uppercase tracking-wide">Live mapping (runs in your browser, no API)</h2>
            </div>
            <div className="space-y-2 mb-10">
                {demo.map((d, i) => (
                    <div key={i} className="rounded-lg border border-gray-200 dark:border-white/[0.08] overflow-hidden">
                        <button onClick={() => setOpen(open === i ? null : i)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-white/[0.03]">
                            {d.result.deterministic
                                ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                : <Cpu className="w-4 h-4 text-gray-400 shrink-0" />}
                            <span className="text-sm text-gray-800 dark:text-gray-100 flex-1">{d.q}</span>
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0 ${d.result.deterministic ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-gray-100 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400'}`}>
                                {d.result.deterministic ? 'DETERMINISTIC' : 'AI SQL'}
                            </span>
                        </button>
                        {open === i && (
                            <div className="px-4 py-3 border-t border-gray-100 dark:border-white/[0.06] bg-gray-50/60 dark:bg-white/[0.02]">
                                <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">{d.result.detail}</div>
                                {d.result.sql && (
                                    <pre className="text-[11px] leading-relaxed overflow-x-auto rounded-md bg-white dark:bg-black/40 border border-gray-200 dark:border-white/[0.08] p-3 text-gray-800 dark:text-gray-200 whitespace-pre">{d.result.sql}</pre>
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </div>

            {/* Deterministic knob catalog */}
            <div className="flex items-center gap-2 mb-3">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                <h2 className="text-sm font-extrabold text-gray-900 dark:text-white uppercase tracking-wide">Deterministic knobs</h2>
            </div>
            <div className="space-y-6 mb-10">
                {GROUPS.map(group => (
                    <div key={group}>
                        <div className="text-xs font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">{group}</div>
                        <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] divide-y divide-gray-100 dark:divide-white/[0.06]">
                            {DETERMINISTIC_KNOBS.filter(k => k.group === group).map(k => (
                                <div key={k.name} className="px-4 py-3 grid grid-cols-1 md:grid-cols-3 gap-1 md:gap-4">
                                    <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{k.name}</div>
                                    <div className="text-xs text-gray-500 dark:text-gray-400 italic">“{k.example}”</div>
                                    <code className="text-[11px] text-indigo-700 dark:text-indigo-300 break-words">{k.sqlShape}</code>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>

            {/* AI-routed shapes */}
            <div className="flex items-center gap-2 mb-3">
                <CircleDashed className="w-4 h-4 text-gray-400" />
                <h2 className="text-sm font-extrabold text-gray-900 dark:text-white uppercase tracking-wide">Routed to the AI engine</h2>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-white/[0.08] divide-y divide-gray-100 dark:divide-white/[0.06] mb-10">
                {AI_ROUTED_SHAPES.map(s => (
                    <div key={s.name} className="px-4 py-3">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">{s.name}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${s.kind === 'wip' ? 'bg-amber-100 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-gray-100 dark:bg-white/[0.06] text-gray-500 dark:text-gray-400'}`}>
                                {s.kind === 'wip' ? 'BUILDER CAN — WIRING PENDING' : 'NEEDS NEW KNOB'}
                            </span>
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 italic mb-1">“{s.example}”</div>
                        <div className="text-xs text-gray-600 dark:text-gray-300">{s.reason}</div>
                    </div>
                ))}
            </div>
        </div>
    );
};
