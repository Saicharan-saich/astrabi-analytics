/**
 * bank.ts — the question set + ground-truth oracle for Study 1.
 *
 * A small, public-style e-commerce dataset (orders with a region, product,
 * status, an additive money column, an ORDINAL rating, and a RATE) chosen so the
 * questions can trigger every silent-error class in the taxonomy. Ground truth
 * for each question is computed INDEPENDENTLY in plain JavaScript from the raw
 * rows — this is the oracle the systems under test are graded against, so no
 * system's own SQL is ever trusted to define correctness.
 *
 * Each question also carries a hand-authored AnalysisPlan, which stands in for a
 * correct planner so the HYBRID arm can be evaluated end-to-end (plan → the
 * deterministic correctSQL engine → DuckDB). This isolates and measures our
 * actual contribution — the plan→SQL compilation and its guards — independently
 * of natural-language parsing.
 */
import type { AnswerRequirements } from './taxonomy';

export interface OrderRow {
    order_id: number;
    region: string;
    product: string;
    status: string;
    revenue: number;
    quantity: number;
    satisfaction_rating: number; // 1–5 ordinal — must never be SUMmed
    conversion_rate: number;     // 0–1 rate — must never be SUMmed
}

export const SCHEMA = ['order_id', 'region', 'product', 'status', 'revenue', 'quantity', 'satisfaction_rating', 'conversion_rate'];

const REGIONS = ['North', 'South', 'East', 'West'];
const PRODUCTS = ['Widget', 'Gadget', 'Gizmo'];
// Title-cased on purpose: the app's ETL normalizes categorical casing, so we use
// the canonical values the data actually holds. A correct planner resolves the
// user's word ("completed") to this canonical value; Study 1 measures the
// execution engine, not case-insensitive string matching.
const STATUSES = ['Completed', 'Cancelled', 'Refunded'];

/** Deterministic dataset — same every run, so results are reproducible. */
export function buildOrders(n = 600): OrderRow[] {
    return Array.from({ length: n }, (_, i) => ({
        order_id: 10000 + i,
        region: REGIONS[i % 4],
        product: PRODUCTS[i % 3],
        status: STATUSES[i % 3 === 0 ? 0 : (i % 2 ? 1 : 2)], // ~half completed
        revenue: 50 + (i * 37) % 4000,
        quantity: 1 + (i % 6),
        satisfaction_rating: 1 + (i % 5),
        conversion_rate: ((i % 50) + 1) / 100, // 0.01–0.50
    }));
}

type Plan = any; // AnalysisPlan — typed loosely here; the engine validates it.

export interface QuestionCase {
    id: string;
    question: string;
    /** True answer computed independently in JS. Scalar or label→value map. */
    groundTruth: (rows: OrderRow[]) => number | Record<string, number>;
    /** A correct plan, standing in for the planner, for the hybrid arm. */
    plan: Plan;
    /** What a correct SQL must satisfy — used by the grader's silent-error detector. */
    req: AnswerRequirements;
    /** Which silent error a naive tool most plausibly commits here (for the writeup). */
    riskyClass: string;
}

const scalarPlan = (o: Partial<Plan>): Plan => ({
    intent: 'single_metric', dimensions: [], metrics: [], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'scalar', originalQuestion: '', ...o,
});
const groupPlan = (o: Partial<Plan>): Plan => ({
    intent: 'breakdown', dimensions: [], metrics: [], filters: [], sort: [],
    limit: null, ambiguous: false, resultGrain: 'summary', originalQuestion: '', ...o,
});

const sum = (rs: OrderRow[], f: keyof OrderRow) => rs.reduce((a, r) => a + Number(r[f]), 0);
const avg = (rs: OrderRow[], f: keyof OrderRow) => sum(rs, f) / rs.length;
const groupBy = (rs: OrderRow[], dim: keyof OrderRow) => {
    const m = new Map<string, OrderRow[]>();
    for (const r of rs) { const k = String(r[dim]); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return m;
};

export const QUESTIONS: QuestionCase[] = [
    {
        id: 'q1_total_revenue',
        question: 'What is our total revenue?',
        groundTruth: rows => sum(rows, 'revenue'),
        plan: scalarPlan({ metrics: [{ field: 'revenue', agg: 'sum' }] }),
        req: { schema: SCHEMA, metricCol: 'revenue', requiredAgg: 'sum' },
        riskyClass: 'none (baseline)',
    },
    {
        id: 'q2_completed_orders',
        question: 'How many completed orders are there?',
        groundTruth: rows => rows.filter(r => r.status === 'Completed').length,
        // 'eq' (word-form op) deliberately used — exercises the filter-op guard.
        plan: scalarPlan({ metrics: [{ field: 'order_id', agg: 'count' }], filters: [{ field: 'status', op: 'eq', value: 'Completed' }] }),
        req: { schema: SCHEMA, requiredFilterCols: ['status'] },
        riskyClass: 'dropped_filter',
    },
    {
        id: 'q3_avg_rating',
        question: 'What is the average satisfaction rating?',
        groundTruth: rows => avg(rows, 'satisfaction_rating'),
        plan: scalarPlan({ metrics: [{ field: 'satisfaction_rating', agg: 'avg' }] }),
        req: { schema: SCHEMA, metricCol: 'satisfaction_rating', requiredAgg: 'avg', nonAdditiveCols: ['satisfaction_rating'] },
        riskyClass: 'non_additive_sum',
    },
    {
        id: 'q4_avg_conv_by_region',
        question: 'What is the average conversion rate by region?',
        groundTruth: rows => {
            const out: Record<string, number> = {};
            for (const [k, rs] of groupBy(rows, 'region')) out[k] = avg(rs, 'conversion_rate');
            return out;
        },
        plan: groupPlan({ dimensions: [{ field: 'region' }], metrics: [{ field: 'conversion_rate', agg: 'avg' }] }),
        req: { schema: SCHEMA, metricCol: 'conversion_rate', requiredAgg: 'avg', nonAdditiveCols: ['conversion_rate'], requiredGroupByCols: ['region'] },
        riskyClass: 'non_additive_sum / ignored_grouping',
    },
    {
        id: 'q5_revenue_by_region',
        question: 'What is total revenue by region?',
        groundTruth: rows => {
            const out: Record<string, number> = {};
            for (const [k, rs] of groupBy(rows, 'region')) out[k] = sum(rs, 'revenue');
            return out;
        },
        plan: groupPlan({ dimensions: [{ field: 'region' }], metrics: [{ field: 'revenue', agg: 'sum' }] }),
        req: { schema: SCHEMA, metricCol: 'revenue', requiredAgg: 'sum', requiredGroupByCols: ['region'] },
        riskyClass: 'ignored_grouping',
    },
    {
        id: 'q6_revenue_completed',
        question: 'What is the total revenue from completed orders?',
        groundTruth: rows => sum(rows.filter(r => r.status === 'Completed'), 'revenue'),
        plan: scalarPlan({ metrics: [{ field: 'revenue', agg: 'sum' }], filters: [{ field: 'status', op: 'eq', value: 'Completed' }] }),
        req: { schema: SCHEMA, metricCol: 'revenue', requiredAgg: 'sum', requiredFilterCols: ['status'] },
        riskyClass: 'dropped_filter',
    },
    {
        id: 'q7_avg_order_value',
        question: 'What is the average order value?',
        groundTruth: rows => avg(rows, 'revenue'),
        plan: scalarPlan({ metrics: [{ field: 'revenue', agg: 'avg' }] }),
        req: { schema: SCHEMA, metricCol: 'revenue', requiredAgg: 'avg' },
        riskyClass: 'wrong_aggregation',
    },
    {
        id: 'q8_max_order',
        question: 'What is the largest single-order revenue?',
        groundTruth: rows => Math.max(...rows.map(r => r.revenue)),
        plan: scalarPlan({ metrics: [{ field: 'revenue', agg: 'max' }] }),
        req: { schema: SCHEMA, metricCol: 'revenue', requiredAgg: 'max' },
        riskyClass: 'wrong_aggregation',
    },
    {
        id: 'q9_revenue_west',
        question: 'What is the total revenue in the West region?',
        groundTruth: rows => sum(rows.filter(r => r.region === 'West'), 'revenue'),
        plan: scalarPlan({ metrics: [{ field: 'revenue', agg: 'sum' }], filters: [{ field: 'region', op: 'eq', value: 'West' }] }),
        req: { schema: SCHEMA, metricCol: 'revenue', requiredAgg: 'sum', requiredFilterCols: ['region'] },
        riskyClass: 'dropped_filter',
    },
    {
        id: 'q10_distinct_products',
        question: 'How many distinct products do we sell?',
        groundTruth: rows => new Set(rows.map(r => r.product)).size,
        plan: scalarPlan({ metrics: [{ field: 'product', agg: 'count_distinct' }] }),
        req: { schema: SCHEMA, metricCol: 'product', requiredAgg: 'count_distinct' },
        riskyClass: 'wrong_aggregation',
    },
];
