/**
 * Saved and recent Question Builder questions, and the question packs that
 * travel with a cleaning setup. A question is a name and the builder's
 * choices (columns, filter values, sort, time range); never rows.
 */
import type { SavedQuestion } from '../types';

const GRAINS = new Set(['day', 'week', 'month', 'quarter', 'year']);
export const MAX_RECENT = 12;
export const MAX_SAVED = 100;
export const MAX_PACK = 50;

export type MovingPeriod = 'last_month' | 'last_quarter';

export const newQuestionId = () => `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** Every column a question needs. */
export function questionColumns(config: Record<string, any>): string[] {
    const cols = new Set<string>();
    const add = (c: unknown) => { if (typeof c === 'string' && c && !c.startsWith('__') && !GRAINS.has(c)) cols.add(c); };
    add(config.metric);
    add(config.dimension);
    (config.secondaryDimensions || []).forEach(add);
    (config.secondaryMetrics || []).forEach((m: any) => add(typeof m === 'string' ? m : m?.metric || m?.column));
    Object.keys(config.filters || {}).forEach(add);
    (config.dateFilters || []).forEach((d: any) => add(d?.column));
    return [...cols];
}

/** The columns a question needs that this data doesn't have. */
export function missingColumns(config: Record<string, any>, columnNames: string[]): string[] {
    const have = new Set(columnNames);
    return questionColumns(config).filter(c => !have.has(c));
}

/** The builder's choices that make a question what it is (for spotting repeats). */
export function questionKey(config: Record<string, any>): string {
    const pick = ['metric', 'aggregation', 'dimension', 'secondaryDimensions', 'secondaryMetrics', 'timeFilter', 'filters', 'measureFilters', 'dateFilters', 'sort', 'limit', 'comparison', 'comparisonGrain', 'comparisonOffset'];
    const out: Record<string, any> = {};
    for (const k of pick) {
        const v = config[k];
        if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) continue;
        out[k] = v;
    }
    return JSON.stringify(out);
}

/** A copy of the builder's choices to keep: plain JSON, without the builder's own working fields. */
export function keepableConfig(config: Record<string, any>, when?: MovingPeriod | null): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(config || {})))) {
        if (k.startsWith('_')) continue;
        out[k] = v;
    }
    if (when) out._when = when;
    return out;
}

const day = (asOf?: string) => (asOf ? new Date(`${asOf.slice(0, 10)}T12:00:00Z`) : new Date());

/** The full month before the as-of date, as 'YYYY-MM'. */
export function previousMonth(asOf?: string): string {
    const d = day(asOf);
    const m = d.getUTCMonth(); // 0-based: the previous month is m - 1
    const year = m === 0 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
    const month = m === 0 ? 12 : m;
    return `${year}-${String(month).padStart(2, '0')}`;
}

/** The full quarter before the as-of date, as 'YYYY-Qn'. */
export function previousQuarter(asOf?: string): string {
    const d = day(asOf);
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return q === 1 ? `${d.getUTCFullYear() - 1}-Q4` : `${d.getUTCFullYear()}-Q${q - 1}`;
}

/**
 * Is the question about the last full month or quarter? Then it can be kept
 * so it moves with the date: next month it answers for the new last month.
 */
export function movingPeriodOf(config: Record<string, any>, asOf?: string): MovingPeriod | null {
    if (config._when === 'last_month' || config._when === 'last_quarter') return config._when;
    const dfs = config.dateFilters || [];
    if (dfs.length !== 1 || dfs[0]?.values?.length !== 1) return null;
    const { timeGrain, values } = dfs[0];
    if (timeGrain === 'month' && values[0] === previousMonth(asOf)) return 'last_month';
    if (timeGrain === 'quarter' && values[0] === previousQuarter(asOf)) return 'last_quarter';
    return null;
}

/** The question ready to run today: a moving period becomes the current last month or quarter. */
export function questionForToday(config: Record<string, any>, asOf?: string): Record<string, any> {
    const next = JSON.parse(JSON.stringify(config || {}));
    const when = next._when as MovingPeriod | undefined;
    if (!when || !next.dateFilters?.length) return next;
    const value = when === 'last_month' ? previousMonth(asOf) : previousQuarter(asOf);
    next.dateFilters = [{ ...next.dateFilters[0], timeGrain: when === 'last_month' ? 'month' : 'quarter', values: [value] }];
    return next;
}

/** Plain words for a moving period, for the list. */
export function movingPeriodWords(when?: string): string {
    return when === 'last_month' ? 'always last month' : when === 'last_quarter' ? 'always last quarter' : '';
}

/** Recent questions with this one first, repeats removed, capped. */
export function withRecent(list: SavedQuestion[], entry: SavedQuestion, max = MAX_RECENT): SavedQuestion[] {
    const key = questionKey(entry.config);
    return [entry, ...list.filter(q => questionKey(q.config) !== key || q.datasetName !== entry.datasetName)].slice(0, max);
}

/** Add or replace a question in a list (same choices = the same question), newest first. */
export function withSaved(list: SavedQuestion[], entry: SavedQuestion, max = MAX_SAVED): SavedQuestion[] {
    const key = questionKey(entry.config);
    return [entry, ...list.filter(q => q.id !== entry.id && questionKey(q.config) !== key)].slice(0, max);
}

/** Split questions into those this data can answer and those it can't (and why). */
export function sortByFit(questions: SavedQuestion[], columnNames: string[]): { ready: SavedQuestion[]; skipped: { question: SavedQuestion; missing: string[] }[] } {
    const ready: SavedQuestion[] = [];
    const skipped: { question: SavedQuestion; missing: string[] }[] = [];
    for (const question of questions) {
        const missing = missingColumns(question.config || {}, columnNames);
        if (missing.length) skipped.push({ question, missing });
        else ready.push(question);
    }
    return { ready, skipped };
}
