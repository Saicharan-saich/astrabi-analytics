/**
 * useQuestionConfig — shared hook for QuestionBuilder & QuestionCustomizer
 *
 * Encapsulates:
 *  - Filter types & state management
 *  - Column value caching (getColumnValues / getDateValues)
 *  - Grain helpers (getNextGrain / getPriorGrain)
 *  - handleRun config builder
 *  - Auto-run effect
 *  - Initial sync effect
 *  - Filter CRUD (add / remove / update)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Dataset, ColumnType } from '../types';

// ─── Filter Types ────────────────────────────────────────────────────

export interface DimensionFilter {
    id: number;
    type: 'dimension';
    column: string;
    value: string | string[];
}

export interface MeasureFilter {
    id: number;
    type: 'measure';
    column: string;
    operator: '>=' | '<=' | '=' | '!=' | '>' | '<';
    value: number;
}

export interface DateFilter {
    id: number;
    type: 'date';
    column: string;
    timeGrain: 'year' | 'quarter' | 'month' | 'week' | 'day';
    values: string[];
}

export type Filter = DimensionFilter | MeasureFilter | DateFilter;

// ─── Grain Helpers ───────────────────────────────────────────────────

export const getNextGrain = (grain: string): string | null => {
    switch (grain) {
        case 'year': return 'quarter';
        case 'quarter': return 'month';
        case 'month': return 'week';
        case 'week': return 'day';
        default: return null;
    }
};

export const getPriorGrain = (grain: string): string | null => {
    switch (grain) {
        case 'quarter': return 'year';
        case 'month': return 'quarter';
        case 'week': return 'month';
        case 'day': return 'week';
        default: return null;
    }
};

// ─── ISO Week Number ────────────────────────────────────────────────

const getISOWeek = (date: Date): number => {
    const target = new Date(date.valueOf());
    const dayNr = (date.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
        target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
    }
    return 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
};

// ─── Hook Options ───────────────────────────────────────────────────

export interface UseQuestionConfigOptions {
    dataset: Dataset;
    onRun: (config: any) => void;
    initialMetric?: string;
    initialAggregation?: string;
    initialDimension?: string;
    initialTimeFilter?: string;
    initialLimit?: number;
    initialSort?: 'desc' | 'asc';
    /** If true, auto-run is enabled (default true) */
    autoRun?: boolean;
    /** Debounce delay in ms (default 400) */
    debounceMs?: number;
}

// ─── Hook Return ────────────────────────────────────────────────────

export interface UseQuestionConfigReturn {
    // State
    metric: string;
    setMetric: (v: string) => void;
    aggregation: string;
    setAggregation: (v: string) => void;
    dimension: string;
    setDimension: (v: string) => void;
    timeFilter: string;
    setTimeFilter: (v: string) => void;
    sort: 'desc' | 'asc' | 'oldest' | 'newest';
    setSort: (v: 'desc' | 'asc' | 'oldest' | 'newest') => void;
    limit: number;
    setLimit: (v: number) => void;
    filters: Filter[];

    // Column helpers
    metrics: string[];
    dims: string[];
    dateColumns: string[];
    getColumnValues: (columnName: string) => string[];
    getDateValues: (columnName: string, grain: string, selectedParentValues?: string[]) => string[];

    // Actions
    handleRun: () => void;
    addFilter: (type: 'dimension' | 'measure' | 'date', column?: string, grain?: string) => void;
    removeFilter: (id: number) => void;
    updateFilter: (id: number, field: string, value: any) => void;

    // Refs for keyboard shortcuts
    handleRunRef: React.MutableRefObject<() => void>;
}

// ─── Hook Implementation ────────────────────────────────────────────

export function useQuestionConfig(opts: UseQuestionConfigOptions): UseQuestionConfigReturn {
    const {
        dataset,
        onRun,
        initialMetric = '',
        initialAggregation = 'SUM',
        initialDimension = '',
        initialTimeFilter = 'all_time',
        initialLimit = 0,
        initialSort = 'desc',
        autoRun = true,
        debounceMs = 400,
    } = opts;

    // ── Core State ───────────────────────────────────────────────────
    const [metric, setMetric] = useState<string>(initialMetric);
    const [aggregation, setAggregation] = useState<string>(initialAggregation);
    const [dimension, setDimension] = useState<string>(initialDimension);
    const [timeFilter, setTimeFilter] = useState(initialTimeFilter);
    const [sort, setSort] = useState<'desc' | 'asc' | 'oldest' | 'newest'>(initialSort as any || 'desc');
    const [limit, setLimit] = useState<number>(initialLimit);
    const [filters, setFilters] = useState<Filter[]>([]);
    const [nextFilterId, setNextFilterId] = useState(1);

    // Refs
    const ignoreNextRun = useRef(false);
    const onRunRef = useRef(onRun);
    useEffect(() => { onRunRef.current = onRun; });
    const handleRunRef = useRef<() => void>(() => { });

    // ── Column Metadata ──────────────────────────────────────────────
    const metrics = dataset.columns
        .filter(c => c.type === ColumnType.METRIC)
        .map(c => c.name);

    const dims = dataset.columns
        .filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID)
        .map(c => c.name);

    const dateColumns = dataset.columns
        .filter(c => c.type === ColumnType.DATE)
        .map(c => c.name);

    // ── Initial Sync ─────────────────────────────────────────────────
    useEffect(() => {
        let changed = false;
        if (initialMetric !== undefined && initialMetric !== metric) { setMetric(initialMetric); changed = true; }
        if (initialAggregation !== undefined && initialAggregation !== aggregation) { setAggregation(initialAggregation); changed = true; }
        if (initialDimension !== undefined && initialDimension !== dimension) { setDimension(initialDimension); changed = true; }
        if (initialTimeFilter !== undefined && initialTimeFilter !== timeFilter) { setTimeFilter(initialTimeFilter); changed = true; }
        if (initialLimit !== undefined && initialLimit !== limit) { setLimit(initialLimit); changed = true; }
        if (initialSort !== undefined && initialSort !== sort) { setSort(initialSort); changed = true; }
        if (changed) ignoreNextRun.current = true;
    }, [initialMetric, initialDimension, initialTimeFilter, initialLimit, initialSort, initialAggregation]);

    // Auto-select metric if empty
    useEffect(() => {
        if (!metric && metrics.length) {
            setMetric(metrics.find(m => m.includes('revenue') || m.includes('sales')) || metrics[0]);
        }
    }, [dataset]);

    // ── Column Value Caching ─────────────────────────────────────────
    const columnValuesCache = useRef<Record<string, string[]>>({});
    useEffect(() => { columnValuesCache.current = {}; }, [dataset]);

    const getColumnValues = useCallback((columnName: string): string[] => {
        if (!columnName || !dataset.rows.length) return [];
        if (columnValuesCache.current[columnName]) return columnValuesCache.current[columnName];

        const row0 = dataset.rows[0];
        const actualKey = Object.keys(row0).find(k => k.toLowerCase() === columnName.toLowerCase()) || columnName;

        const uniqueValues = new Set<string>();
        const maxRows = 10000;
        const rowsToScan = dataset.rows.length > maxRows ? dataset.rows.slice(0, maxRows) : dataset.rows;

        rowsToScan.forEach(row => {
            const val = row[actualKey];
            if (val !== null && val !== undefined && val !== '') uniqueValues.add(String(val));
        });

        const values = Array.from(uniqueValues).sort().slice(0, 100);
        columnValuesCache.current[columnName] = values;
        return values;
    }, [dataset]);

    const getDateValues = useCallback((columnName: string, grain: string, selectedParentValues: string[] = []): string[] => {
        if (!columnName || !dataset.rows.length) return [];

        const cacheKey = selectedParentValues.length > 0
            ? `${columnName}__${grain}__${selectedParentValues.sort().join('_')}`
            : `${columnName}__${grain}`;
        if (columnValuesCache.current[cacheKey]) return columnValuesCache.current[cacheKey];

        const row0 = dataset.rows[0];
        const actualKey = Object.keys(row0).find(k => k.toLowerCase() === columnName.toLowerCase()) || columnName;
        const uniqueValues = new Set<string>();
        const maxRows = 10000;
        const rowsToScan = dataset.rows.length > maxRows ? dataset.rows.slice(0, maxRows) : dataset.rows;
        const pad = (n: number) => n.toString().padStart(2, '0');

        rowsToScan.forEach(row => {
            const val = row[actualKey];
            if (!val || val === 'null' || val === 'undefined') return;
            const dateStr = String(val);

            let d: Date | null = null;
            if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
                const parts = dateStr.split('-').map(Number);
                d = new Date(parts[0], parts[1] - 1, parts[2], 12);
            } else if (dateStr.indexOf('/') > -1) {
                const parts = dateStr.split('/');
                if (parts.length === 3) d = new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]), 12);
            } else {
                d = new Date(dateStr);
            }

            if (d && !isNaN(d.getTime())) {
                const year = d.getFullYear();
                const month = d.getMonth() + 1;
                const day = d.getDate();

                // Parent filter check
                if (selectedParentValues.length > 0) {
                    const firstParent = selectedParentValues[0];
                    let parentMatches = false;
                    if (firstParent.match(/^\d{4}$/)) {
                        parentMatches = selectedParentValues.includes(`${year}`);
                    } else if (firstParent.match(/^\d{4}-Q\d$/)) {
                        const q = Math.ceil(month / 3);
                        parentMatches = selectedParentValues.includes(`${year}-Q${q}`);
                    } else if (firstParent.match(/^\d{4}-\d{2}$/)) {
                        parentMatches = selectedParentValues.includes(`${year}-${pad(month)}`);
                    } else if (firstParent.match(/^\d{4}-W\d{2}$/)) {
                        const week = getISOWeek(d);
                        parentMatches = selectedParentValues.includes(`${year}-W${pad(week)}`);
                    }
                    if (!parentMatches) return;
                }

                let formatted = '';
                if (grain === 'year') formatted = `${year}`;
                else if (grain === 'quarter') { const q = Math.ceil(month / 3); formatted = `${year}-Q${q}`; }
                else if (grain === 'month') formatted = `${year}-${pad(month)}`;
                else if (grain === 'week') { const week = getISOWeek(d); formatted = `${year}-W${pad(week)}`; }
                else if (grain === 'day') formatted = `${year}-${pad(month)}-${pad(day)}`;
                if (formatted) uniqueValues.add(formatted);
            }
        });

        const values = Array.from(uniqueValues).sort();
        columnValuesCache.current[cacheKey] = values;
        return values;
    }, [dataset]);

    // ── handleRun ────────────────────────────────────────────────────
    const handleRun = useCallback(() => {
        const dimensionFilters: Record<string, string[]> = {};
        const measureFiltersList: Array<{ column: string; operator: string; value: number }> = [];
        const dateFiltersList: Array<{ column: string; timeGrain: string; values: string[] }> = [];

        filters.forEach(f => {
            if (f.type === 'dimension' && f.column) {
                const values = Array.isArray(f.value) ? f.value : (f.value ? [f.value] : []);
                if (values.length > 0) dimensionFilters[f.column] = values;
            } else if (f.type === 'measure' && f.column) {
                measureFiltersList.push({ column: f.column, operator: f.operator, value: f.value });
            } else if (f.type === 'date' && f.column) {
                if (f.values && f.values.length > 0) dateFiltersList.push({ column: f.column, timeGrain: f.timeGrain, values: f.values });
            }
        });

        onRunRef.current({
            metric,
            aggregation,
            dimension,
            timeFilter,
            filters: dimensionFilters,
            measureFilters: measureFiltersList,
            dateFilters: dateFiltersList,
            sort,
            limit
        });
    }, [metric, aggregation, dimension, timeFilter, filters, sort, limit]);

    // Keep ref in sync
    useEffect(() => { handleRunRef.current = handleRun; });

    // ── Auto-Run ─────────────────────────────────────────────────────
    useEffect(() => {
        if (!autoRun || !metric) return;
        if (ignoreNextRun.current) { ignoreNextRun.current = false; return; }
        const timer = setTimeout(() => handleRun(), debounceMs);
        return () => clearTimeout(timer);
    }, [metric, aggregation, dimension, timeFilter, filters, sort, limit]);

    // ── Auto-Drill Down ──────────────────────────────────────────────
    useEffect(() => {
        filters.forEach(f => {
            if (f.type === 'date' && f.values && f.values.length === 1 && f.column) {
                const nextGrain = getNextGrain(f.timeGrain);
                if (nextGrain) {
                    const hierarchy = ['year', 'quarter', 'month', 'week', 'day'];
                    const nextIdx = hierarchy.indexOf(nextGrain);
                    if (nextIdx !== -1) {
                        const hasDescendant = filters.some(c =>
                            c.type === 'date' && c.column === f.column &&
                            hierarchy.indexOf(c.timeGrain) >= nextIdx
                        );
                        if (!hasDescendant) {
                            addFilter('date', f.column, nextGrain);
                        }
                    }
                }
            }
        });
    }, [filters]);

    // ── Filter CRUD ──────────────────────────────────────────────────
    const addFilter = useCallback((type: 'dimension' | 'measure' | 'date', column?: string, grain?: string) => {
        setFilters(prev => {
            const newFilter: Filter = type === 'date'
                ? { id: nextFilterId, type: 'date', column: column || dateColumns[0] || '', timeGrain: (grain as any) || 'year', values: [] }
                : type === 'dimension'
                    ? { id: nextFilterId, type: 'dimension', column: '', value: '' }
                    : { id: nextFilterId, type: 'measure', column: metric || (metrics.length ? metrics[0] : ''), operator: '>', value: 0 };
            return [...prev, newFilter];
        });
        setNextFilterId(prev => prev + 1);
    }, [nextFilterId, dateColumns, metric, metrics]);

    const removeFilter = useCallback((id: number) => {
        setFilters(prev => prev.filter(f => f.id !== id));
    }, []);

    const updateFilter = useCallback((id: number, field: string, value: any) => {
        setFilters(prevFilters => {
            const updatedFilters = prevFilters.map(f => {
                if (f.id === id) {
                    if (field === 'column' && f.type === 'dimension') return { ...f, [field]: value, value: [] };
                    return { ...f, [field]: value };
                }
                return f;
            });

            // Recursive reset for date hierarchy
            if (field === 'values') {
                const parent = updatedFilters.find(f => f.id === id);
                if (parent && parent.type === 'date' && parent.column) {
                    // Auto-switch to Trend mode when multi-select
                    if (value && value.length > 1 && !dimension) {
                        const grain = (parent.timeGrain as string) || 'day';
                        setDimension(grain);
                        setSort('oldest');
                    }

                    const grainOrder = ['year', 'quarter', 'month', 'week', 'day'];
                    const parentGrainIdx = grainOrder.indexOf(parent.timeGrain);
                    if (parentGrainIdx !== -1) {
                        return updatedFilters.filter(f => {
                            if (f.type !== 'date') return true;
                            if (f.column !== parent.column) return true;
                            if (f.id === parent.id) return true;
                            const childGrainIdx = grainOrder.indexOf(f.timeGrain);
                            return childGrainIdx <= parentGrainIdx;
                        });
                    }
                }
            }
            return updatedFilters;
        });
    }, [dimension]);

    return {
        metric, setMetric,
        aggregation, setAggregation,
        dimension, setDimension,
        timeFilter, setTimeFilter,
        sort, setSort,
        limit, setLimit,
        filters,
        metrics, dims, dateColumns,
        getColumnValues,
        getDateValues,
        handleRun,
        addFilter,
        removeFilter,
        updateFilter,
        handleRunRef,
    };
}
