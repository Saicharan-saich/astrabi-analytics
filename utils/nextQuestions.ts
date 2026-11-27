/**
 * Next questions to ask, from the shape of the answer on screen: what the
 * leader is made of, the leader over time, the answer without a dominant
 * group, what happened in an unusual period, the same period a year before,
 * a coarser or finer grain. Each is a full builder question, built with the
 * same helpers as clicking a bar, so it filters exactly the same way.
 */
import type { AnalysisResult, Dataset } from '../types';
import { drillConfig, drillOptions, excludeConfig, isGrainKey, primaryDateColumn, resolveTargets } from './explore';
import { questionKey } from './savedQuestions';

export interface NextQuestion {
    label: string;
    config: Record<string, any>;
    /** Why it's suggested, for the button's tooltip. */
    why: string;
}

const words = (s: string) => s.replace(/_/g, ' ').trim();
const TIME_LABEL: Record<string, string> = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const periodWords = (key: string) => {
    let m = /^(\d{4})-(\d{2})$/.exec(key); if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
    m = /^(\d{4})-Q([1-4])$/.exec(key); if (m) return `Q${m[2]} ${m[1]}`;
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key); if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
    return key;
};
const short = (s: string, n = 28) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function points(result: AnalysisResult) {
    return (result.data || [])
        .map(row => ({ key: String(row[result.xKey] ?? ''), value: Number(row[result.yKey]) }))
        .filter(p => p.key !== '' && p.key !== 'null' && Number.isFinite(p.value));
}

/** The period furthest from the usual level (robust to a few outliers), if it really stands out. */
export function unusualPeriod(values: { key: string; value: number }[]): { key: string; value: number; high: boolean } | null {
    if (values.length < 6) return null;
    const sorted = [...values.map(v => v.value)].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const deviations = values.map(v => Math.abs(v.value - median)).sort((a, b) => a - b);
    const mad = deviations[Math.floor(deviations.length / 2)] || Math.abs(median) * 0.05 || 1;
    let best: { key: string; value: number; score: number } | null = null;
    for (const v of values) {
        const score = Math.abs(v.value - median) / mad;
        if (!best || score > best.score) best = { ...v, score };
    }
    return best && best.score >= 3.5 ? { key: best.key, value: best.value, high: best.value > median } : null;
}

export function nextQuestions(dataset: Dataset, config: Record<string, any> | null | undefined, result: AnalysisResult | undefined, max = 4): NextQuestion[] {
    if (!config || !result || result.error || !result.data?.length || !config.metric) return [];
    const out: NextQuestion[] = [];
    const seen = new Set<string>([questionKey(config)]);
    const add = (q: NextQuestion | null | undefined) => {
        if (!q || out.length >= max) return;
        const key = questionKey(q.config);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(q);
    };
    const dim = config.dimension ? String(config.dimension) : '';
    const comparing = Boolean(config.comparison && config.comparison !== 'none');
    const dateColumn = primaryDateColumn(dataset);

    // A split by two things: one step back is often the clearer picture.
    if (config.secondaryDimensions?.length) {
        const { secondaryDimensions, ...rest } = config;
        add({ label: `Without the split by ${words(secondaryDimensions[0])}`, config: rest, why: 'Fewer lines, one total per point' });
    }

    // A single total: split it.
    if (!dim) {
        const options = drillOptions(dataset, config, [], 3);
        for (const option of options) add({ label: option.label, config: drillConfig(config, [], option), why: 'Split this total' });
        return out;
    }

    const pts = points(result);
    if (isGrainKey(dim)) {
        // Something unusual happened in one period: what was it?
        const odd = unusualPeriod(pts);
        if (odd && !comparing) {
            const targets = resolveTargets(dataset, dim, { value: odd.key, label: periodWords(odd.key) });
            const option = drillOptions(dataset, config, targets, 4).find(o => o.kind === 'column');
            if (targets.length && option) add({ label: `What happened in ${periodWords(odd.key)}?`, config: drillConfig(config, targets, option), why: `${periodWords(odd.key)} is unusually ${odd.high ? 'high' : 'low'}; see it ${option.label}` });
        }
        // The latest period, broken down.
        const last = pts.length ? [...pts].sort((a, b) => a.key.localeCompare(b.key))[pts.length - 1] : null;
        if (last && !comparing) {
            const targets = resolveTargets(dataset, dim, { value: last.key, label: periodWords(last.key) });
            const option = drillOptions(dataset, config, targets, 4).find(o => o.kind === 'column');
            if (targets.length && option) add({ label: `${periodWords(last.key)} ${option.label}`, config: drillConfig(config, targets, option), why: 'The latest period, broken down' });
        }
        // The year before, side by side.
        const span = pts.length && dim === 'month' ? pts.length : dim === 'quarter' ? pts.length * 3 : dim === 'week' ? pts.length / 4.3 : dim === 'day' ? pts.length / 30 : pts.length * 12;
        if (!comparing && span >= 13 && dim !== 'year') {
            add({ label: 'Against the year before', config: { ...config, comparison: 'same_period_last_n', comparisonGrain: 'year', comparisonOffset: 1 }, why: 'Each period next to the same one a year earlier' });
        }
        // A grain that reads better.
        if (dim === 'month' && pts.length > 24) add({ label: 'By quarter', config: { ...config, dimension: 'quarter', sort: 'oldest' }, why: 'Fewer, steadier points' });
        else if (dim === 'day' && pts.length > 60) add({ label: 'By week', config: { ...config, dimension: 'week', sort: 'oldest' }, why: 'Fewer, steadier points' });
        else if (dim === 'month' && pts.length <= 4) add({ label: 'By week', config: { ...config, dimension: 'week', sort: 'oldest' }, why: 'More detail in a short period' });
        // Split over time by the most useful grouping.
        const split = drillOptions(dataset, config, [], 2).find(o => o.kind === 'column');
        if (split && !comparing) add({ label: `Over time ${split.label}`, config: { ...config, secondaryDimensions: [split.value] }, why: 'One line for each' });
        return out;
    }

    // A split by a category.
    const ranked = [...pts].sort((a, b) => b.value - a.value);
    const leader = ranked[0];
    const total = ranked.reduce((s, p) => s + Math.max(0, p.value), 0);
    if (leader && ranked.length >= 2) {
        const targets = resolveTargets(dataset, dim, { value: leader.key, label: leader.key });
        const options = targets.length ? drillOptions(dataset, config, targets, 4) : [];
        const column = options.find(o => o.kind === 'column');
        if (column) add({ label: `${short(leader.key)} ${column.label}`, config: drillConfig(config, targets, column), why: `What ${leader.key}, the biggest, is made of` });
        const overTime = options.find(o => o.kind === 'grain');
        if (overTime && dateColumn) add({ label: `${short(leader.key)} over time`, config: drillConfig(config, targets, overTime), why: `Is ${leader.key} growing or shrinking?` });
        const share = total > 0 ? leader.value / total : 0;
        if (share >= 0.35 && ranked.length >= 3 && targets[0]?.kind === 'column') {
            add({ label: `Without ${short(leader.key)}`, config: excludeConfig(dataset, config, targets[0] as any), why: `${leader.key} is ${Math.round(share * 100)}% of the total; see how the rest compare` });
        }
    }
    if (!config.limit && ranked.length >= 8) add({ label: 'Smallest 5', config: { ...config, limit: -5, sort: 'asc' }, why: 'The bottom of the list' });
    if (dateColumn && !comparing && ranked.length <= 12) add({ label: `Over time by ${words(dim)}`, config: { ...config, dimension: 'month', secondaryDimensions: [dim], sort: 'oldest', limit: undefined }, why: 'One line for each' });
    return out;
}
