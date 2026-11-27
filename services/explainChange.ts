/**
 * "Why did this change?" for a Question Builder answer over time.
 *
 * Takes one period of the answer and the one before it, splits the same
 * question by each sensible grouping (re-running it through the engine, so
 * every filter and time range the person chose still applies), and says which
 * grouping explains the change best: the group that moved most, the ones that
 * went the other way, and how much of the change each accounts for.
 *
 * Only totals and counts are split this way: an average or a distinct count
 * doesn't add up across groups, so the parts wouldn't explain the whole.
 */
import type { AnalysisResult, Dataset } from '../types';

export const TIME_GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);
const ADDITIVE = new Set(['SUM', 'COUNT']);

export interface Mover { key: string; before: number; after: number; delta: number }
export interface ChangeExplanation {
    from: { key: string; label: string; value: number };
    to: { key: string; label: string; value: number };
    change: number;
    /** Change as a share of the earlier period (null when that was 0). */
    pct: number | null;
    grouping: string;
    groupingLabel: string;
    /** Biggest movers first, in the grouping that explains most. */
    movers: Mover[];
    /** Share of all movement the top group accounts for (0–1). */
    share: number;
    sentences: string[];
    /** Other groupings that explain a fair part, to look at next. */
    alternatives: { grouping: string; label: string; top: Mover }[];
}

export type ExplainRun = (config: Record<string, any>) => Promise<AnalysisResult>;

const words = (s: string) => s.replace(/_/g, ' ').trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A period key as people say it: '2026-03' → 'Mar 2026', '2026-Q1' → 'Q1 2026'. */
export function periodLabel(key: string): string {
    const k = String(key);
    let m = /^(\d{4})-(\d{2})$/.exec(k);
    if (m) return `${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
    m = /^(\d{4})-Q([1-4])$/.exec(k);
    if (m) return `Q${m[2]} ${m[1]}`;
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(k);
    if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
    m = /^(\d{4})-W(\d{2})$/.exec(k);
    if (m) return `week ${Number(m[2])} of ${m[1]}`;
    return k;
}

/** Plain, short numbers: 1,234 / 12.3k / 4.5M. */
export function shortNumber(v: number): string {
    const a = Math.abs(v);
    const sign = v < 0 ? '−' : '';
    const trim = (t: string) => t.replace(/\.0(?=[a-zA-Z]*$)/, '');
    if (a >= 1e4) return trim(longShort(a, sign));
    return `${sign}${a.toLocaleString('en-GB', { maximumFractionDigits: a < 10 ? 2 : 0 })}`;
}
function longShort(a: number, sign: string): string {
    if (a >= 1e9) return `${sign}${(a / 1e9).toFixed(a >= 1e10 ? 0 : 1)}bn`;
    if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
    return `${sign}${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
}
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${shortNumber(Math.abs(v))}`;
const pctText = (v: number) => `${Math.round(v * 100)}%`;

/** Can this answer be explained this way? */
export function canExplainChange(config: Record<string, any> | undefined, result: AnalysisResult | undefined): boolean {
    if (!config || !result || result.error || !result.data || result.data.length < 2) return false;
    if (!TIME_GRAINS.has(String(config.dimension))) return false;
    if (config.secondaryDimensions?.length || config.secondaryMetrics?.length) return false;
    if (config.comparison && config.comparison !== 'none') return false;
    return ADDITIVE.has(String(config.aggregation || 'SUM').toUpperCase());
}

/** The answer's periods, oldest first. */
export function periodsOf(result: AnalysisResult): { key: string; value: number }[] {
    return (result.data || [])
        .map(row => ({ key: String(row[result.xKey]), value: Number(row[result.yKey]) }))
        .filter(p => p.key && p.key !== 'null' && Number.isFinite(p.value))
        .sort((a, b) => a.key.localeCompare(b.key));
}

/** Groupings worth splitting by: categories with 2–30 values that aren't fixed by a filter. */
export function candidateGroupings(dataset: Dataset, config: Record<string, any>, max = 8): string[] {
    const rows = dataset.rows || [];
    const fixed = new Set(Object.entries(config.filters || {}).filter(([, v]) => Array.isArray(v) && v.length === 1).map(([k]) => k));
    const out: { name: string; distinct: number }[] = [];
    for (const col of dataset.columns) {
        if (col.type !== 'DIMENSION' || col.name.startsWith('__') || fixed.has(col.name)) continue;
        const seen = new Set<string>();
        for (let i = 0; i < rows.length && seen.size <= 30; i++) {
            const v = rows[i]?.[col.name];
            if (v !== null && v !== undefined && v !== '') seen.add(String(v));
        }
        if (seen.size >= 2 && seen.size <= 30 && rows.length / seen.size >= 3) out.push({ name: col.name, distinct: seen.size });
    }
    return out.sort((a, b) => a.distinct - b.distinct).slice(0, max).map(g => g.name);
}

/**
 * Explain the change into `toKey` (default: the latest period) from the
 * period before it. Null when there is no change worth explaining or no
 * grouping explains it.
 */
export async function explainChange(dataset: Dataset, config: Record<string, any>, result: AnalysisResult, run: ExplainRun, toKey?: string): Promise<ChangeExplanation | null> {
    if (!canExplainChange(config, result)) return null;
    const periods = periodsOf(result);
    const at = toKey ? periods.findIndex(p => p.key === toKey) : periods.length - 1;
    if (at < 1) return null;
    const from = periods[at - 1];
    const to = periods[at];
    const change = to.value - from.value;
    const scale = Math.max(Math.abs(from.value), Math.abs(to.value), 1e-9);
    if (Math.abs(change) < scale * 0.005) return null;

    const tried: { grouping: string; movers: Mover[]; share: number }[] = [];
    for (const grouping of candidateGroupings(dataset, config)) {
        let split: AnalysisResult;
        try {
            split = await run({ ...config, secondaryDimensions: [grouping], limit: undefined, sort: 'oldest' });
        } catch { continue; }
        if (split.error || !split.data?.length) continue;
        const xKey = split.xKey; const yKey = split.yKey;
        const before = new Map<string, number>(); const after = new Map<string, number>();
        for (const row of split.data) {
            const period = String(row[xKey]);
            const group = row[grouping] === null || row[grouping] === undefined || row[grouping] === '' ? '(blank)' : String(row[grouping]);
            const v = Number(row[yKey]);
            if (!Number.isFinite(v)) continue;
            if (period === from.key) before.set(group, (before.get(group) || 0) + v);
            if (period === to.key) after.set(group, (after.get(group) || 0) + v);
        }
        // The parts must add up to the answer on screen, or they don't explain it.
        const sum = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
        const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(b) * 0.005, 0.01);
        if (!close(sum(before), from.value) || !close(sum(after), to.value)) continue;
        const movers = [...new Set([...before.keys(), ...after.keys()])]
            .map(key => ({ key, before: before.get(key) || 0, after: after.get(key) || 0, delta: (after.get(key) || 0) - (before.get(key) || 0) }))
            .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        const moved = movers.reduce((s, m) => s + Math.abs(m.delta), 0);
        if (movers.length < 2 || !moved || Math.sign(movers[0].delta) !== Math.sign(change)) continue;
        tried.push({ grouping, movers, share: Math.abs(movers[0].delta) / moved });
    }
    if (!tried.length) return null;
    tried.sort((a, b) => b.share - a.share);
    const best = tried[0];
    const [first, second] = best.movers;
    const up = change >= 0;
    const against = best.movers.filter(m => Math.sign(m.delta) !== Math.sign(change) && Math.abs(m.delta) >= Math.abs(change) * 0.1);
    const pct = from.value ? change / Math.abs(from.value) : null;
    const label = words(best.grouping);
    const sentences = [
        `From ${periodLabel(from.key)} to ${periodLabel(to.key)} it went ${up ? 'up' : 'down'} by ${shortNumber(Math.abs(change))}${pct !== null ? ` (${up ? '+' : '−'}${pctText(Math.abs(pct))})` : ''}, and ${label} explains it best.`,
        Math.abs(first.delta) > Math.abs(change)
            ? `${first.key} moved by more than the whole change (${signed(first.delta)}), because others went the other way.`
            : `${first.key} alone accounts for ${pctText(Math.abs(first.delta) / Math.abs(change))} of the ${up ? 'rise' : 'fall'} (${signed(first.delta)})${second && Math.sign(second.delta) === Math.sign(change) ? `; next is ${second.key} (${signed(second.delta)})` : ''}.`,
        ...(against.length ? [`${against.slice(0, 2).map(m => `${m.key} (${signed(m.delta)})`).join(' and ')} went the other way, so without ${against.length > 1 ? 'them' : 'it'} the ${up ? 'rise' : 'fall'} would have been bigger.`] : []),
    ];
    return {
        from: { ...from, label: periodLabel(from.key) },
        to: { ...to, label: periodLabel(to.key) },
        change, pct,
        grouping: best.grouping, groupingLabel: label,
        movers: best.movers.slice(0, 8),
        share: best.share,
        sentences,
        alternatives: tried.slice(1, 3).filter(t => t.share >= 0.25).map(t => ({ grouping: t.grouping, label: words(t.grouping), top: t.movers[0] })),
    };
}
