/**
 * Click-to-explore: what a clicked bar / slice / point means in data terms,
 * and the questions that follow from it (show only, exclude, break down,
 * see the rows). Pure functions so the Builder and dashboards behave alike.
 */
import type { ColumnDefinition, Dataset } from '../types';
import type { DashboardFilter } from '../store/useAppStore';
import { getDates } from '../services/dateHelpers';
import { resolveTimeRange } from '../services/resolveTimeRange';

export type GrainKey = 'year' | 'quarter' | 'month' | 'week' | 'day';
export const GRAIN_ORDER: GrainKey[] = ['year', 'quarter', 'month', 'week', 'day'];
export const isGrainKey = (value: unknown): value is GrainKey => GRAIN_ORDER.includes(value as GrainKey);

/** What the chart reports when a mark is clicked. */
export interface ChartPointSelection {
    xKey: string;
    /** The value as stored in the result row (e.g. "2024-03"). */
    value: string;
    /** The value as shown on the chart (e.g. "Mar 2024"). */
    label: string;
    seriesKey?: string;
    seriesValue?: string;
    /** Small-multiple panel the mark sits in. */
    facetKey?: string;
    facetValue?: string;
    metricValue?: number;
    /** Screen position of the click, for the menu. */
    anchor: { x: number; y: number };
}

/** A clicked value expressed as a filter on the source data. */
export type ExploreTarget =
    | { kind: 'column'; column: string; value: string; label: string }
    | { kind: 'period'; grain: GrainKey; dateColumn: string; from: string; to: string; label: string };

export interface DrillOption {
    kind: 'grain' | 'column';
    value: string;
    label: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** First and last day of a period written as 2024, 2024-Q1, 2024-03, 2024-W05, 2024-03-15, "Mar 2024", "w/c 4 Mar 2024", "4 Mar 2024". */
export function periodRange(raw: string, grainHint?: GrainKey | null): { grain: GrainKey; from: string; to: string } | null {
    const s = String(raw ?? '').trim();
    let m: RegExpMatchArray | null;
    if ((m = s.match(/^(\d{4})$/))) return { grain: 'year', from: `${m[1]}-01-01`, to: `${m[1]}-12-31` };
    const quarter = (year: number, q: number) => {
        const end = q * 3;
        return { grain: 'quarter' as GrainKey, from: `${year}-${pad(end - 2)}-01`, to: `${year}-${pad(end)}-${lastDayOfMonth(year, end)}` };
    };
    if ((m = s.match(/^(\d{4})-?Q([1-4])$/i))) return quarter(Number(m[1]), Number(m[2]));
    if ((m = s.match(/^Q([1-4])\s+(\d{4})$/i))) return quarter(Number(m[2]), Number(m[1]));
    if ((m = s.match(/^(\d{4})-W(\d{1,2})$/i))) {
        // ISO week: the week with the year's first Thursday is week 1.
        const year = Number(m[1]), week = Number(m[2]);
        const jan4 = new Date(Date.UTC(year, 0, 4));
        const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (week - 1) * 7 * 86_400_000);
        return { grain: 'week', from: iso(monday), to: iso(new Date(monday.getTime() + 6 * 86_400_000)) };
    }
    if ((m = s.match(/^(\d{4})-(\d{2})$/))) {
        const y = Number(m[1]), mo = Number(m[2]);
        return { grain: 'month', from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${lastDayOfMonth(y, mo)}` };
    }
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) {
        const day = `${m[1]}-${m[2]}-${m[3]}`;
        if (grainHint === 'week') {
            const d = new Date(`${day}T00:00:00Z`);
            return { grain: 'week', from: day, to: iso(new Date(d.getTime() + 6 * 86_400_000)) };
        }
        if (grainHint === 'month') return periodRange(day.slice(0, 7));
        return { grain: 'day', from: day, to: day };
    }
    if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/))) {
        const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        if (mo > 0) return periodRange(`${m[2]}-${pad(mo)}`);
    }
    if ((m = s.match(/^(w\/c\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/i))) {
        const mo = MONTHS.indexOf(m[3].toLowerCase()) + 1;
        if (mo > 0) return periodRange(`${m[4]}-${pad(mo)}-${pad(Number(m[2]))}`, m[1] ? 'week' : 'day');
    }
    return null;
}

const GRAIN_WORD: Record<GrainKey, string> = { year: 'year', quarter: 'quarter', month: 'month', week: 'week', day: 'day' };

/** The date column Builder time groupings run on. */
export function primaryDateColumn(dataset: Dataset): string | null {
    const anchor = dataset.timeContext?.anchorDateColumn;
    if (anchor && dataset.columns.some(c => c.name === anchor)) return anchor;
    return dataset.columns.find(c => c.type === 'DATE')?.name || null;
}

const columnNamed = (dataset: Dataset, name?: string | null): ColumnDefinition | undefined =>
    name ? dataset.columns.find(c => c.name === name) : undefined;

/**
 * What the click means: the grouping it belongs to (a column value or a
 * period), plus the series it belongs to when the series is a real column.
 */
export function resolveTargets(
    dataset: Dataset,
    dimension: string | undefined,
    selection: Pick<ChartPointSelection, 'value' | 'label' | 'seriesKey' | 'seriesValue' | 'facetKey' | 'facetValue'>,
    hints: { dateColumn?: string | null; grain?: GrainKey | null } = {},
): ExploreTarget[] {
    const targets: ExploreTarget[] = [];
    const value = String(selection.value ?? '');
    if (dimension && isGrainKey(dimension)) {
        const dateColumn = hints.dateColumn || primaryDateColumn(dataset);
        const range = periodRange(value, dimension) || periodRange(selection.label, dimension);
        if (dateColumn && range) targets.push({ kind: 'period', grain: range.grain, dateColumn, from: range.from, to: range.to, label: selection.label || value });
    } else if (dimension && columnNamed(dataset, dimension)) {
        const column = columnNamed(dataset, dimension)!;
        if (column.type === 'DATE') {
            const range = periodRange(value, hints.grain) || periodRange(selection.label, hints.grain);
            if (range) targets.push({ kind: 'period', grain: range.grain, dateColumn: column.name, from: range.from, to: range.to, label: selection.label || value });
        } else {
            targets.push({ kind: 'column', column: column.name, value, label: selection.label || value });
        }
    }
    if (selection.seriesKey && selection.seriesValue !== undefined && columnNamed(dataset, selection.seriesKey)
        && selection.seriesKey !== dimension) {
        targets.push({ kind: 'column', column: selection.seriesKey, value: String(selection.seriesValue), label: String(selection.seriesValue) });
    }
    if (selection.facetKey && selection.facetValue !== undefined && columnNamed(dataset, selection.facetKey)
        && selection.facetKey !== dimension && !targets.some(t => t.kind === 'column' && t.column === selection.facetKey)) {
        targets.push({ kind: 'column', column: selection.facetKey, value: String(selection.facetValue), label: String(selection.facetValue) });
    }
    return targets;
}

const dateKey = (value: unknown): string => {
    if (value instanceof Date) return iso(value);
    const s = String(value ?? '');
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const t = Date.parse(s);
    return Number.isFinite(t) ? iso(new Date(t)) : '';
};

/** Does a row fall inside every target? */
export function rowMatchesTargets(row: Record<string, any>, targets: ExploreTarget[]): boolean {
    return targets.every(target => {
        if (target.kind === 'column') return String(row[target.column] ?? '').toLowerCase() === target.value.toLowerCase();
        const key = dateKey(row[target.dateColumn]);
        return key !== '' && key >= target.from && key <= target.to;
    });
}

/** Rows a Builder question covers (its filters), before grouping. */
export function rowsForBuilderConfig(dataset: Dataset, config: any): Record<string, any>[] {
    let rows = dataset.rows || [];
    const filters: Record<string, string[]> = config?.filters || {};
    for (const [column, values] of Object.entries(filters)) {
        if (!Array.isArray(values) || values.length === 0) continue;
        const allowed = new Set(values.map(v => String(v).toLowerCase()));
        rows = rows.filter(row => allowed.has(String(row[column] ?? '').toLowerCase()));
    }
    for (const mf of (config?.measureFilters || []) as Array<{ column: string; operator: string; value: number }>) {
        rows = rows.filter(row => {
            const n = Number(row[mf.column]);
            if (!Number.isFinite(n)) return false;
            switch (mf.operator) {
                case '>': return n > mf.value; case '<': return n < mf.value; case '>=': return n >= mf.value;
                case '<=': return n <= mf.value; case '!=': return n !== mf.value; default: return n === mf.value;
            }
        });
    }
    const dateColumn = primaryDateColumn(dataset);
    for (const df of (config?.dateFilters || []) as Array<{ column?: string; timeGrain: string; values: string[] }>) {
        const column = df.column || dateColumn;
        if (!column || !df.values?.length) continue;
        if (df.values.length === 1 && df.values[0].includes('__')) {
            const [from, to] = df.values[0].split('__');
            rows = rows.filter(row => { const k = dateKey(row[column]); return k >= from && k <= to; });
            continue;
        }
        const allowed = new Set(df.values);
        rows = rows.filter(row => {
            const k = dateKey(row[column]);
            if (!k) return false;
            if (df.timeGrain === 'year') return allowed.has(k.slice(0, 4));
            if (df.timeGrain === 'quarter') return allowed.has(`${k.slice(0, 4)}-Q${Math.ceil(Number(k.slice(5, 7)) / 3)}`);
            if (df.timeGrain === 'month') return allowed.has(k.slice(0, 7));
            return allowed.has(k);
        });
    }
    if (config?.timeFilter && dateColumn) {
        const anchor = config.asOfDate || dataset.timeContext?.defaultAnchorDate || dataset.timeContext?.maxDate;
        const range = anchor ? resolveTimeRange(config.timeFilter, getDates(anchor)) : null;
        if (range) rows = rows.filter(row => { const k = dateKey(row[dateColumn]); return k >= range.start && k <= range.end; });
    }
    return rows;
}

/* Common business hierarchies, coarse → fine. */
const HIERARCHIES: RegExp[][] = [
    [/^(continent|world_?region)$/, /^(country|nation)/, /^(region|state|province|county|territory)/, /^(city|town)/, /^(post_?code|zip)/, /(store|branch|site|location)/],
    [/^(department|division)/, /(category|segment)$/, /^(sub_?category|subcategory)/, /^(brand)/, /^(product|item|sku)/],
    [/^(category|product_?category)$/, /^(sub_?category)/, /^(product|item)/],
    [/^(channel)/, /^(campaign)/, /^(ad_?group|ad|creative)/],
    [/^(team|department)/, /^(manager)/, /^(employee|rep|agent|salesperson)/],
];

function hierarchyScore(from: string, to: string): number {
    const a = from.toLowerCase(), b = to.toLowerCase();
    let best = 0;
    for (const chain of HIERARCHIES) {
        const i = chain.findIndex(re => re.test(a));
        const j = chain.findIndex(re => re.test(b));
        if (i >= 0 && j > i) best = Math.max(best, 10 - (j - i));
    }
    if (b.startsWith(`sub_${a}`) || b.startsWith(`sub${a}`) || (b.includes(a) && b !== a)) best = Math.max(best, 9);
    return best;
}

/**
 * Ways to break the clicked value down: finer time grains first (Year →
 * Quarter → Month → Day), then the dimensions that actually vary inside the
 * selection, related ones (country → city) first.
 */
export function drillOptions(dataset: Dataset, config: any, targets: ExploreTarget[], limit = 6): DrillOption[] {
    const options: DrillOption[] = [];
    const current = String(config?.dimension || '');
    const period = targets.find((t): t is Extract<ExploreTarget, { kind: 'period' }> => t.kind === 'period');
    const scope = rowsForBuilderConfig(dataset, config).filter(row => rowMatchesTargets(row, targets));
    if (scope.length === 0) return [];
    const sample = scope.length > 20_000 ? scope.filter((_, i) => i % Math.ceil(scope.length / 20_000) === 0) : scope;

    if (period) {
        const start = GRAIN_ORDER.indexOf(period.grain);
        const spanDays = (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1;
        for (const grain of GRAIN_ORDER.slice(start + 1)) {
            if (grain === 'week' && spanDays < 14) continue;
            if (grain === 'quarter' && spanDays < 120) continue;
            options.push({ kind: 'grain', value: grain, label: `by ${GRAIN_WORD[grain]}` });
            if (options.length >= 2) break;
        }
    }

    const used = new Set<string>([current, ...(config?.secondaryDimensions || []), ...targets.map(t => (t.kind === 'column' ? t.column : ''))]);
    const candidates = dataset.columns
        .filter(c => c.type === 'DIMENSION' && !used.has(c.name))
        .map(c => {
            const distinct = new Set<string>();
            for (const row of sample) {
                const v = row[c.name];
                if (v === null || v === undefined || v === '') continue;
                distinct.add(String(v));
                if (distinct.size > 200) break;
            }
            return { column: c, distinct: distinct.size };
        })
        .filter(c => c.distinct > 1 && c.distinct <= 200)
        .map(c => ({ ...c, score: hierarchyScore(period ? '' : current, c.column.name) * 100 + (c.distinct <= 30 ? 50 - Math.abs(c.distinct - 8) : 0) }))
        .sort((a, b) => b.score - a.score || a.distinct - b.distinct);
    for (const c of candidates) {
        if (options.length >= limit) break;
        options.push({ kind: 'column', value: c.column.name, label: `by ${c.column.name.replace(/_/g, ' ')}` });
    }

    // A category slice can also be looked at over time.
    if (!period && !isGrainKey(current) && primaryDateColumn(dataset) && options.length < limit + 1) {
        const months = new Set(sample.slice(0, 5000).map(r => dateKey(r[primaryDateColumn(dataset)!]).slice(0, 7)).filter(Boolean));
        if (months.size >= 3) options.push({ kind: 'grain', value: 'month', label: 'over time (by month)' });
    }
    return options;
}

function withTargets(config: any, targets: ExploreTarget[]): any {
    const next = { ...config, filters: { ...(config?.filters || {}) }, dateFilters: [...(config?.dateFilters || [])] };
    for (const target of targets) {
        if (target.kind === 'column') next.filters[target.column] = [target.value];
        else {
            next.dateFilters = next.dateFilters.filter((df: any) => !((df.column || '') === target.dateColumn && df.values?.length === 1 && String(df.values[0]).includes('__')));
            next.dateFilters.push({ column: target.dateColumn, timeGrain: 'day', values: [`${target.from}__${target.to}`] });
        }
    }
    if (next.dateFilters.length === 0) delete next.dateFilters;
    return next;
}

/** Show only the clicked value(s). */
export function keepConfig(config: any, targets: ExploreTarget[]): any {
    return withTargets(config, targets);
}

/** Leave the clicked category out (period exclusion is not offered). */
export function excludeConfig(dataset: Dataset, config: any, target: Extract<ExploreTarget, { kind: 'column' }>): any {
    const scope = rowsForBuilderConfig(dataset, { ...config, filters: { ...(config?.filters || {}), [target.column]: [] } });
    const remaining = [...new Set(scope.map(r => String(r[target.column] ?? '')).filter(v => v !== '' && v.toLowerCase() !== target.value.toLowerCase()))];
    return { ...config, filters: { ...(config?.filters || {}), [target.column]: remaining } };
}

/** Break the clicked value down by another dimension or a finer time grain. */
export function drillConfig(config: any, targets: ExploreTarget[], option: DrillOption): any {
    const next = withTargets(config, targets);
    const fixed = new Set(targets.filter(t => t.kind === 'column').map(t => (t as any).column));
    next.dimension = option.value;
    next.secondaryDimensions = (config?.secondaryDimensions || []).filter((d: string) => d !== option.value && !fixed.has(d));
    if (!next.secondaryDimensions.length) delete next.secondaryDimensions;
    if (option.kind === 'grain') {
        next.sort = 'oldest';
        delete next.limit;
        delete next.timeFilter; // the period filter already sets the window
    }
    return next;
}

/** A dashboard-wide filter for one target. */
export function dashboardFilterFor(target: ExploreTarget): DashboardFilter {
    return target.kind === 'column'
        ? { column: target.column, type: 'dimension', values: [target.value] }
        : { column: target.dateColumn, type: 'dimension', values: [], dateMode: 'range', dateRange: { from: target.from, to: target.to } };
}

/** Dashboard filter that leaves one category out (as the list of the others). */
export function dashboardExcludeFilter(rows: Record<string, any>[], target: Extract<ExploreTarget, { kind: 'column' }>): DashboardFilter {
    const others = [...new Set(rows.map(r => String(r[target.column] ?? '')).filter(v => v !== '' && v !== target.value))].sort();
    return { column: target.column, type: 'dimension', values: others };
}

/** Is this target already the dashboard's filter (so the click should clear it)? */
export function dashboardFilterIsActive(filters: DashboardFilter[], target: ExploreTarget): boolean {
    return filters.some(f => target.kind === 'column'
        ? f.column === target.column && !f.dateMode && f.values.length === 1 && f.values[0] === target.value
        : f.column === target.dateColumn && f.dateMode === 'range' && f.dateRange?.from === target.from && f.dateRange?.to === target.to);
}

/** Readable description: "category is Electronics", "order date in Mar 2024". */
export function describeTarget(target: ExploreTarget): string {
    return target.kind === 'column'
        ? `${target.column.replace(/_/g, ' ')} is ${target.value}`
        : `${target.dateColumn.replace(/_/g, ' ')} in ${target.label}`;
}
