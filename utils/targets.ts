/**
 * Targets and budgets on Question Builder charts: a target line the person
 * types in, or a budget column already in their data, and how each bar or
 * point stands against it (ahead, behind, by how much).
 */
import type { AnalysisResult, Dataset } from '../types';

export interface ChartTarget {
    value: number;
    /** What to call it on the chart: Target, Budget, Plan… */
    label: string;
    /** The measure it belongs to; it is drawn only on answers about this measure. */
    metric: string;
}

export interface StandAgainst {
    ahead: number;
    behind: number;
    total: number;
    /** The furthest behind (most negative gap). */
    worst?: { key: string; gap: number; pct: number | null };
    /** The furthest ahead. */
    best?: { key: string; gap: number; pct: number | null };
}

const BUDGET = /(^|_)(budget|budgeted|target|plan|planned|forecast|quota|goal|expected)($|_)/i;
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !BUDGET.test(t));

/** A budget-like measure in the data that goes with this measure (revenue → revenue_budget). */
export function budgetColumnFor(dataset: Dataset, metric: string): string | null {
    if (!metric || BUDGET.test(metric)) return null;
    const mine = new Set(tokens(metric));
    const candidates = dataset.columns.filter(c => c.type === 'METRIC' && c.name !== metric && BUDGET.test(c.name));
    if (!candidates.length) return null;
    const scored = candidates.map(c => ({ name: c.name, score: tokens(c.name).filter(t => mine.has(t)).length }));
    scored.sort((a, b) => b.score - a.score);
    // With several budget columns, only pick one that names this measure.
    if (candidates.length > 1 && scored[0].score === 0) return null;
    return scored[0].name;
}

/** The result's key for a secondary measure. */
export function secondaryKeyFor(result: AnalysisResult, column: string): string | null {
    const keys: string[] = (result as any).secondaryYKeys || [];
    const hit = keys.find(k => k === column || k.endsWith(`_${column}`) || k.includes(column));
    if (hit) return hit;
    const row = result.data?.[0] || {};
    return Object.keys(row).find(k => k !== result.yKey && k.includes(column)) || null;
}

/** How each bar or point stands against a fixed target or a budget value in the same row. */
export function standAgainst(result: AnalysisResult, against: number | string): StandAgainst | null {
    const rows = result.data || [];
    if (!rows.length || !result.yKey) return null;
    let ahead = 0; let behind = 0; let total = 0;
    let worst: StandAgainst['worst']; let best: StandAgainst['best'];
    for (const row of rows) {
        const value = Number(row[result.yKey]);
        const goal = typeof against === 'number' ? against : Number(row[against]);
        if (!Number.isFinite(value) || !Number.isFinite(goal)) continue;
        total++;
        const gap = value - goal;
        if (gap >= 0) ahead++; else behind++;
        const pct = goal ? gap / Math.abs(goal) : null;
        const key = String(row[result.xKey] ?? '');
        if (!worst || gap < worst.gap) worst = { key, gap, pct };
        if (!best || gap > best.gap) best = { key, gap, pct };
    }
    if (!total) return null;
    return { ahead, behind, total, worst: worst && worst.gap < 0 ? worst : undefined, best: best && best.gap > 0 ? best : undefined };
}

/** Is this target for the answer on screen? */
export function targetFor(target: ChartTarget | undefined, config: Record<string, any> | null | undefined): ChartTarget | null {
    if (!target || !config?.metric || !Number.isFinite(target.value)) return null;
    return target.metric === config.metric ? target : null;
}
