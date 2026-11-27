/**
 * Warnings before an answer misleads, each with a one-click fix:
 *  - the last period isn't over yet, so it looks low;
 *  - a rate or percentage is being added up;
 *  - a top N hides most of the total;
 *  - rows are counted where each ID should count once.
 * Worked out from the cleaned rows and the builder's choices; the fix is a
 * builder question, so it runs and is checked like any other.
 */
import type { AnalysisResult, Dataset } from '../types';
import { primaryDateColumn, rowsForBuilderConfig } from './explore';

export interface AnswerWarning {
    id: 'partial_period' | 'summed_rate' | 'top_hides_total' | 'counted_rows';
    text: string;
    fixLabel: string;
    fix: Record<string, any>;
}

const words = (s: string) => s.replace(/_/g, ' ').trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const RATE = /(^|_)(rate|ratio|percent|percentage|pct|share|conversion|ctr|avg|average|mean|rating|nps|satisfaction)($|_)|%/i;
const GRAINS = new Set(['month', 'quarter', 'year']);
const dayKey = (v: unknown): string => {
    if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const t = Date.parse(String(v ?? ''));
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const dayWords = (k: string) => `${Number(k.slice(8, 10))} ${MONTHS[Number(k.slice(5, 7)) - 1]}`;

/** The period a day falls in, with its first and last day. */
function periodOf(day: string, grain: string): { key: string; label: string; start: string; end: string } {
    const y = Number(day.slice(0, 4)); const m = Number(day.slice(5, 7));
    const last = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    if (grain === 'year') return { key: String(y), label: String(y), start: `${y}-01-01`, end: `${y}-12-31` };
    if (grain === 'quarter') {
        const q = Math.ceil(m / 3); const endMonth = q * 3;
        return { key: `${y}-Q${q}`, label: `Q${q} ${y}`, start: `${y}-${pad(endMonth - 2)}-01`, end: `${y}-${pad(endMonth)}-${pad(last(y, endMonth))}` };
    }
    return { key: `${y}-${pad(m)}`, label: `${MONTHS[m - 1]} ${y}`, start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(last(y, m))}` };
}
const dayBefore = (k: string) => { const d = new Date(`${k}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return dayKey(d); };

export function answerWarnings(dataset: Dataset, config: Record<string, any> | null | undefined, result: AnalysisResult | undefined, asOf?: string): AnswerWarning[] {
    if (!config || !result || result.error || !result.data?.length || !config.metric) return [];
    if (config.comparison && config.comparison !== 'none') return [];
    const out: AnswerWarning[] = [];
    const agg = String(config.aggregation || 'SUM').toUpperCase();
    const additive = agg === 'SUM' || agg === 'COUNT';
    const dim = String(config.dimension || '');
    const metric = String(config.metric);
    const column = dataset.columns.find(c => c.name === metric);
    let scope: Record<string, any>[] | null = null;
    const rows = () => (scope ??= rowsForBuilderConfig(dataset, { ...config, asOfDate: asOf || config.asOfDate }));

    // 1. The last period isn't over yet.
    const dateColumn = primaryDateColumn(dataset);
    if (additive && GRAINS.has(dim) && dateColumn) {
        let min = ''; let max = '';
        const lastDay = new Map<string, string>();
        for (const row of rows()) {
            const k = dayKey(row[dateColumn]);
            if (!k) continue;
            if (!min || k < min) min = k;
            if (!max || k > max) max = k;
            const p = periodOf(k, dim).key;
            if ((lastDay.get(p) || '') < k) lastDay.set(p, k);
        }
        const keys = result.data.map(r => String(r[result.xKey])).sort();
        const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
        if (max) {
            const period = periodOf(max, dim);
            // Data that never reaches the end of a period (orders only up to the
            // 27th, say) isn't a short last period: compare with the periods before.
            const usualGap = Math.max(0, ...[...lastDay.entries()]
                .filter(([p]) => p !== period.key).sort(([a], [b]) => a.localeCompare(b)).slice(-3)
                .map(([p, d]) => daysBetween(d, periodOf(d, dim).end)));
            if (keys[keys.length - 1] === period.key && keys.length >= 2 && daysBetween(max, period.end) > usualGap + 1) {
                out.push({
                    id: 'partial_period',
                    text: `${period.label} only has data up to ${dayWords(max)}, so it will look lower than a full ${dim}.`,
                    fixLabel: `Leave out ${period.label}`,
                    fix: { ...config, dateFilters: [...(config.dateFilters || []), { column: dateColumn, timeGrain: 'day', values: [`${min}__${dayBefore(period.start)}`] }] },
                });
            }
        }
    }

    // 2. A rate or percentage added up.
    if (agg === 'SUM' && column && RATE.test(metric)) {
        out.push({
            id: 'summed_rate',
            text: `${words(metric).replace(/^./, c => c.toUpperCase())} looks like a rate or score for each row; adding them up doesn't give a meaningful total.`,
            fixLabel: 'Use the average',
            fix: { ...config, aggregation: 'AVG' },
        });
    }

    // 3. A top N that hides most of the total.
    const limit = Number(config.limit) || 0;
    if (additive && limit > 0 && dim && !GRAINS.has(dim) && !config.secondaryDimensions?.length) {
        let total = 0;
        const groups = new Set<string>();
        for (const row of rows()) {
            const v = agg === 'COUNT' ? (row[metric] === null || row[metric] === undefined || row[metric] === '' ? 0 : 1) : Number(row[metric]);
            if (!Number.isFinite(v)) continue;
            total += v;
            groups.add(String(row[dim] ?? ''));
        }
        const shown = result.data.reduce((s, r) => s + (Number(r[result.yKey]) || 0), 0);
        const others = groups.size - result.data.length;
        if (total > 0 && others > 0 && shown / total < 0.5) {
            out.push({
                id: 'top_hides_total',
                text: `These ${result.data.length} are only ${Math.round((shown / total) * 100)}% of the total; the other ${others} ${words(dim)} values make up the rest.`,
                fixLabel: groups.size <= 60 ? `Show all ${groups.size}` : 'Show the top 25',
                fix: { ...config, limit: groups.size <= 60 ? 0 : 25 },
            });
        }
    }

    // 4. Rows counted where each ID should count once.
    if (agg === 'COUNT' && column?.type === 'ID') {
        let count = 0;
        const distinct = new Set<string>();
        for (const row of rows()) {
            const v = row[metric];
            if (v === null || v === undefined || v === '') continue;
            count++;
            distinct.add(String(v));
        }
        if (count && distinct.size < count * 0.98) {
            out.push({
                id: 'counted_rows',
                text: `Some ${words(metric)} values appear on more than one row, so this counts ${count.toLocaleString('en-GB')} rows rather than ${distinct.size.toLocaleString('en-GB')} different ${words(metric)} values.`,
                fixLabel: 'Count each once',
                fix: { ...config, aggregation: 'COUNT_DISTINCT' },
            });
        }
    }
    return out;
}
