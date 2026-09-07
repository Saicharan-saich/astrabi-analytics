import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { ChevronDown, Plus, Calendar, Settings, ArrowUpDown, Filter, X, TrendingUp, List, Hash, SlidersHorizontal, Layers, MapPin, Clock, Check, Search, Calculator, GitCompareArrows, Blocks } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import type { TableCalculation } from '../utils/tableCalculations';
import { FilterItem } from './FilterItem';
import { DateFilterItem } from './DateFilterItem';
import { Tooltip } from './Tooltip';
import { QuerySelect } from './QuerySelect';
import { resolvePhysicalBuilderFields } from '../services/questionBuilderFieldGuard';

interface QuestionBuilderProps {
    dataset: Dataset;
    onRun: (config: any) => void;
    initialMetric?: string;
    initialAggregation?: string;
    initialDimension?: string;
    initialTimeFilter?: string;
    initialLimit?: number;
    initialSort?: 'desc' | 'asc';
    initialComparison?: string;
    initialComparisonGrain?: string;
    initialComparisonOffset?: number;
    initialSecondaryMetrics?: string[];
    initialSecondaryMetricVisuals?: Record<string, string>;
    initialSecondaryMetricAggregations?: Record<string, string>;
    initialSecondaryDimensions?: string[];
    initialFilters?: Record<string, string[]>;
    initialMeasureFilters?: Array<{ column: string; operator: string; value: number }>;
    initialDateFilters?: Array<{ column: string; timeGrain: string; values: string[] }>;
    asOfDate: string;
    onDateChange: (date: string) => void;
    anchorColumn?: string;
    onAnchorColumnChange?: (col: string) => void;
    /** Whether the Question Builder route is currently visible. */
    isActive?: boolean;
    tableCalculations?: TableCalculation[];
    movingAvgWindow?: number;
    onTableCalculationsChange?: (calculations: TableCalculation[]) => void;
    onMovingAvgWindowChange?: (windowSize: number) => void;
    /** Restrict an AI SQL handoff to the editable GAFS surface. */
    mode?: 'full' | 'gafs';
}

type BuilderTab = 'build' | 'time' | 'compare' | 'calculations';

interface DimensionFilter {
    id: number;
    type: 'dimension';
    column: string;
    value: string | string[]; // Support both single and multi-select
    /** Internal marker for the inline dimension-value picker. */
    _autoDim?: boolean;
}

interface MeasureFilter {
    id: number;
    type: 'measure';
    column: string;
    operator: '>=' | '<=' | '=' | '!=' | '>' | '<';
    value: number;
}

interface DateFilter {
    id: number;
    type: 'date';
    column: string;
    mode: 'hierarchy' | 'range';
    // Hierarchy mode selections
    year?: string | string[];
    quarter?: string | string[];
    month?: string | string[];
    day?: string | string[];
    // Range mode selections
    rangeStart?: string;
    rangeEnd?: string;
    // Computed by DateFilterItem for downstream use
    timeGrain?: string;
    values?: string[];
}

type Filter = DimensionFilter | MeasureFilter | DateFilter;

function hydrateInitialFilters(
    dimensions: Record<string, string[]> = {},
    measures: Array<{ column: string; operator: string; value: number }> = [],
    dates: Array<{ column: string; timeGrain: string; values: string[] }> = [],
): Filter[] {
    let id = 1;
    const restored: Filter[] = [];
    for (const [column, values] of Object.entries(dimensions)) {
        if (!column || !values?.length) continue;
        restored.push({ id: id++, type: 'dimension', column, value: [...values] });
    }
    for (const filter of measures) {
        if (!filter?.column || !Number.isFinite(Number(filter.value))) continue;
        restored.push({
            id: id++, type: 'measure', column: filter.column,
            operator: filter.operator as MeasureFilter['operator'], value: Number(filter.value),
        });
    }
    for (const filter of dates) {
        if (!filter?.column || !filter.values?.length) continue;
        const range = String(filter.values[0]).split('__');
        if (range.length === 2 && range[0] && range[1]) {
            restored.push({
                id: id++, type: 'date', column: filter.column, mode: 'range',
                rangeStart: range[0], rangeEnd: range[1], timeGrain: 'day', values: [...filter.values],
            });
        } else {
            const grain = ['year', 'quarter', 'month', 'day'].includes(filter.timeGrain) ? filter.timeGrain : 'year';
            restored.push({
                id: id++, type: 'date', column: filter.column, mode: 'hierarchy',
                year: grain === 'year' ? [...filter.values] : [],
                quarter: grain === 'quarter' ? [...filter.values] : [],
                month: grain === 'month' ? [...filter.values] : [],
                day: grain === 'day' ? [...filter.values] : [],
                timeGrain: grain, values: [...filter.values],
            });
        }
    }
    return restored;
}

export const QuestionBuilder: React.FC<QuestionBuilderProps> = ({
    dataset,
    onRun,
    initialMetric = '',
    initialAggregation = 'SUM',
    initialDimension = '',
    initialTimeFilter = 'all_time',
    initialLimit = 0,
    initialSort = 'desc',
    initialComparison = '',
    initialComparisonGrain = 'month',
    initialComparisonOffset = 1,
    initialSecondaryMetrics = [],
    initialSecondaryMetricVisuals = {},
    initialSecondaryMetricAggregations = {},
    initialSecondaryDimensions = [],
    initialFilters = {},
    initialMeasureFilters = [],
    initialDateFilters = [],
    asOfDate,
    onDateChange,
    anchorColumn,
    onAnchorColumnChange,
    isActive = true,
    tableCalculations = [],
    movingAvgWindow = 3,
    onTableCalculationsChange,
    onMovingAvgWindowChange,
    mode = 'full',
}) => {
    const gafsOnly = mode === 'gafs';
    const [metric, setMetric] = useState<string>(initialMetric);
    const [aggregation, setAggregation] = useState<string>(initialAggregation);
    const [dimension, setDimension] = useState<string>(
        initialDimension && !['day','week','month','quarter','year','hour','minute'].includes(initialDimension) ? initialDimension : ''
    );
    const [timeGrain, setTimeGrain] = useState<string>(
        initialDimension && ['day','week','month','quarter','year','hour','minute'].includes(initialDimension) ? initialDimension : ''
    );
    const [timeFilter, setTimeFilter] = useState(initialTimeFilter);
    const [sort, setSort] = useState<'desc' | 'asc' | 'oldest' | 'newest'>(initialSort as any || 'desc');
    const [limit, setLimit] = useState<number>(initialLimit);
    // Keep an editable text draft so users can clear/replace a custom limit.
    // Binding the input directly to `limit` and coercing an empty value to 1
    // makes backspace immediately snap to 1, which feels like the control is
    // refusing to change.
    const [customLimitDraft, setCustomLimitDraft] = useState<string>(String(initialLimit > 0 ? initialLimit : 15));

    const [filters, setFilters] = useState<Filter[]>(() => hydrateInitialFilters(initialFilters, initialMeasureFilters, initialDateFilters));
    const [nextFilterId, setNextFilterId] = useState(() => hydrateInitialFilters(initialFilters, initialMeasureFilters, initialDateFilters).length + 1);

    // Secondary metrics for combo/dual-axis charts
    const [secondaryMetrics, setSecondaryMetrics] = useState<string[]>(initialSecondaryMetrics);
    const [secondaryMetricVisuals, setSecondaryMetricVisuals] = useState<Record<string, string>>(initialSecondaryMetricVisuals);
    const [secondaryMetricAggregations, setSecondaryMetricAggregations] = useState<Record<string, string>>(initialSecondaryMetricAggregations);

    // Secondary dimensions for multi-dimension grouping
    const [secondaryDimensions, setSecondaryDimensions] = useState<string[]>(initialSecondaryDimensions);

    // Comparison state
    const [comparison, setComparison] = useState<string>(initialComparison);
    const [comparisonGrain, setComparisonGrain] = useState<string>(initialComparisonGrain);
    const [comparisonOffset, setComparisonOffset] = useState<number>(initialComparisonOffset);
    const [activeBuilderTab, setActiveBuilderTab] = useState<BuilderTab>('build');

    // UI Enhancement states
    const [showOptions, setShowOptions] = useState(false);
    const [showFilterMenu, setShowFilterMenu] = useState(false);
    const filterMenuRef = useRef<HTMLDivElement>(null);
    const filterButtonRef = useRef<HTMLButtonElement>(null);
    const filterPanelRef = useRef<HTMLDivElement>(null);
    const optionsButtonRef = useRef<HTMLButtonElement>(null);
    const [optionsPos, setOptionsPos] = useState<{
        top: number;
        left: number;
        maxHeight: number;
        placement: 'up' | 'down';
    }>({ top: 0, left: 8, maxHeight: 320, placement: 'down' });
    const [filterMenuPos, setFilterMenuPos] = useState<{
        top: number;
        left: number;
        placement: 'up' | 'down';
    }>({ top: 0, left: 8, placement: 'down' });

    useEffect(() => {
        setShowOptions(false);
        setShowFilterMenu(false);
    }, [activeBuilderTab]);

    // Computed: is the current grouping a time grain?
    const isTimeDimension = !!timeGrain;
    // Effective dimension sent to the engine (timeGrain takes priority)
    const effectiveDimension = timeGrain || dimension;

    // Auto-expand options row when any refinement is active
    useEffect(() => {
        if (comparison || (limit > 0) || (isTimeDimension && sort !== 'oldest') || (!isTimeDimension && sort !== 'desc')) {
            setShowOptions(true);
        }
    }, [comparison, limit, sort, isTimeDimension, timeGrain]);

    // Keep the Options panel in the larger usable side of the viewport.
    useEffect(() => {
        if (!showOptions || !optionsButtonRef.current) return;
        const updatePosition = () => {
            const rect = optionsButtonRef.current?.getBoundingClientRect();
            if (!rect) return;
            const viewportPadding = 8;
            const gap = 8;
            const desiredHeight = 520;
            const panelWidth = Math.min(360, window.innerWidth - viewportPadding * 2);
            const availableAbove = Math.max(0, rect.top - viewportPadding - gap);
            const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - gap);
            const placement: 'up' | 'down' =
                availableBelow >= desiredHeight || availableBelow >= availableAbove ? 'down' : 'up';
            const availableHeight = placement === 'up' ? availableAbove : availableBelow;
            setOptionsPos({
                top: placement === 'up' ? rect.top - gap : rect.bottom + gap,
                left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - panelWidth - viewportPadding)),
                maxHeight: Math.max(180, Math.min(desiredHeight, availableHeight)),
                placement
            });
        };
        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [showOptions]);

    // Keep the compact Add Filter menu visible in the viewport too.
    useEffect(() => {
        if (!showFilterMenu || !filterButtonRef.current) return;
        const updatePosition = () => {
            const rect = filterButtonRef.current?.getBoundingClientRect();
            if (!rect) return;
            const viewportPadding = 8;
            const gap = 8;
            const desiredHeight = 150;
            const menuWidth = 240;
            const availableAbove = Math.max(0, rect.top - viewportPadding - gap);
            const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - gap);
            const placement: 'up' | 'down' =
                availableBelow >= desiredHeight || availableBelow >= availableAbove ? 'down' : 'up';
            setFilterMenuPos({
                top: placement === 'up' ? rect.top - gap : rect.bottom + gap,
                left: Math.max(viewportPadding, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding)),
                placement
            });
        };
        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [showFilterMenu]);

    // Close filter menu on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as Node;
            if (filterMenuRef.current && !filterMenuRef.current.contains(target) &&
                (!filterPanelRef.current || !filterPanelRef.current.contains(target))) {
                setShowFilterMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Generate plain English summary
    const summaryText = useMemo(() => {
        if (!metric) return '';
        const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        const aggLabelMap: Record<string, string> = { 'SUM': 'total', 'AVG': 'average', 'COUNT': 'count of', 'COUNT_DISTINCT': 'number of unique', 'MAX': 'highest', 'MIN': 'lowest', 'NONE': '' };
        const aggLabel = aggLabelMap[aggregation] || aggregation.toLowerCase();
        const metricLabel = titleCase(metric);
        let text = aggregation === 'NONE' ? `Showing ${metricLabel} values` : `Showing the ${aggLabel} ${metricLabel}`;
        const dimParts: string[] = [];
        if (dimension) dimParts.push(titleCase(dimension));
        if (timeGrain) dimParts.push(timeGrain);
        if (dimParts.length > 0) {
            text += ` by ${dimParts.join(' over ')}`;
        } else {
            text += ' (overall total)';
        }
        if (timeFilter && timeFilter !== 'all_time') {
            const timeLabels: Record<string, string> = {
                'today': 'for today', 'yesterday': 'for yesterday',
                'this_week': 'for this week', 'this_month': 'for this month',
                'this_quarter': 'for this quarter', 'this_year': 'for this year',
                'last_7_days': 'over the last 7 days', 'last_30_days': 'over the last 30 days',
                'last_90_days': 'over the last 90 days'
            };
            const timeLabel = timeLabels[timeFilter] || (timeFilter.startsWith('last_') ? `over the last ${timeFilter.split('_')[1]} ${timeFilter.split('_')[2] || 'days'}` : `for ${timeFilter.replace(/_/g, ' ')}`);
            text += ` ${timeLabel}`;
        } else {
            text += ' across all time';
        }
        if (comparison === 'previous_period') text += ', compared to the previous period';
        else if (comparison === 'same_period_last_year') text += ', compared to the same period last year';
        else if (comparison === 'same_period_last_n') text += `, compared to the last ${comparisonOffset} ${comparisonGrain}${comparisonOffset > 1 ? 's' : ''}`;
        text += '.';
        return text;
    }, [metric, aggregation, dimension, timeGrain, timeFilter, comparison, comparisonGrain, comparisonOffset]);

    // Auto-sync comparison grain with time filter
    useEffect(() => {
        const grainMap: Record<string, string> = {
            'today': 'day',
            'yesterday': 'day',
            'this_week': 'week',
            'this_month': 'month',
            'this_quarter': 'quarter',
            'this_year': 'year',
            'last_7_days': 'day',
            'last_30_days': 'day',
            'last_90_days': 'day'
        };
        let grain = grainMap[timeFilter];
        // Handle dynamic last_N_unit patterns (e.g. last_5_days, last_2_weeks, last_3_months)
        if (!grain && timeFilter.startsWith('last_')) {
            const parts = timeFilter.split('_');
            const unit = parts[2] || 'days';
            const unitGrainMap: Record<string, string> = {
                'days': 'day', 'weeks': 'week', 'months': 'month',
                'quarters': 'quarter', 'years': 'year', 'cyears': 'year'
            };
            grain = unitGrainMap[unit] || 'day';
        }
        if (grain) {
            setComparisonGrain(grain);
        }
    }, [timeFilter]);

    // Ref to prevent auto-run when syncing from props
    const ignoreNextRun = useRef(false);

    // Valid ref for onRun to avoid stale closures in effects
    const onRunRef = useRef(onRun);
    useEffect(() => { onRunRef.current = onRun; });

    // Ref for handleRun (defined later) — enables keyboard shortcut
    const handleRunRef = useRef<() => void>(() => { });

    // Ctrl+Enter keyboard shortcut
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleRunRef.current();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, []);

    // Parents and default props can allocate fresh arrays/objects on every
    // render. Their identity is not a new configuration: rehydrating from it
    // would erase an unfinished filter whenever the user opens a picker.
    const initialConfigSignature = JSON.stringify([
        dataset.id,
        initialMetric, initialAggregation, initialDimension, initialTimeFilter, initialLimit, initialSort,
        initialComparison, initialComparisonGrain, initialComparisonOffset,
        initialSecondaryMetrics, initialSecondaryMetricVisuals, initialSecondaryMetricAggregations,
        initialSecondaryDimensions, initialFilters, initialMeasureFilters, initialDateFilters,
    ]);
    const lastSyncedInitialConfig = useRef<string>();

    // Sync actual incoming changes, preserving local edits across ordinary renders.
    useEffect(() => {
        if (lastSyncedInitialConfig.current === initialConfigSignature) return;
        lastSyncedInitialConfig.current = initialConfigSignature;
        if (initialMetric) setMetric(initialMetric);
        if (initialAggregation) setAggregation(initialAggregation);
        if (initialDimension) {
            if (['day','week','month','quarter','year','hour','minute'].includes(initialDimension)) {
                setTimeGrain(initialDimension);
                setDimension('');
            } else {
                setDimension(initialDimension);
                setTimeGrain('');
            }
        }
        if (initialTimeFilter) setTimeFilter(initialTimeFilter);
        setLimit(initialLimit);
        setCustomLimitDraft(String(initialLimit > 0 ? initialLimit : 15));
        if (initialSort) setSort(initialSort);
        setComparison(initialComparison);
        setComparisonGrain(initialComparisonGrain);
        setComparisonOffset(initialComparisonOffset);
        setSecondaryMetrics([...initialSecondaryMetrics]);
        setSecondaryMetricVisuals({ ...initialSecondaryMetricVisuals });
        setSecondaryMetricAggregations({ ...initialSecondaryMetricAggregations });
        setSecondaryDimensions([...initialSecondaryDimensions]);
        const restoredFilters = hydrateInitialFilters(initialFilters, initialMeasureFilters, initialDateFilters);
        setFilters(restoredFilters);
        setNextFilterId(restoredFilters.length + 1);

        // Prevent the auto-run effect from firing immediately after this sync
        // because the parent (Workbench) has already run the correct analysis.
        ignoreNextRun.current = true;
    }, [
        initialConfigSignature,
        initialMetric, initialAggregation, initialDimension, initialTimeFilter, initialLimit, initialSort,
        initialComparison, initialComparisonGrain, initialComparisonOffset,
        initialSecondaryMetrics, initialSecondaryMetricVisuals, initialSecondaryMetricAggregations,
        initialSecondaryDimensions, initialFilters, initialMeasureFilters, initialDateFilters,
    ]);

    const commitCustomLimit = (raw: string) => {
        const parsed = Number.parseInt(raw, 10);
        const next = Number.isFinite(parsed) ? Math.max(1, Math.min(10_000, parsed)) : 1;
        setCustomLimitDraft(String(next));
        setLimit(next);
    };

    // Extract columns — filter out AI-hidden junk columns
    const visibleColumns = dataset.columns.filter(c => {
        if (!dataset.domainProfile?.columnSemantics) return true;
        const sem = dataset.domainProfile.columnSemantics[c.name];
        return !sem?.isHidden;
    });
    const metrics = visibleColumns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
    const dims = visibleColumns.filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID).map(c => c.name);
    const countableColumns = visibleColumns.filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID).map(c => c.name);
    const isDimensionMetric = countableColumns.includes(metric);
    const dateColumns = visibleColumns.filter(c => c.type === ColumnType.DATE).map(c => c.name);

    // Helper: get human-readable label for a column
    const getLabel = (colName: string): string => {
        const sem = dataset.domainProfile?.columnSemantics?.[colName];
        return sem?.humanLabel || colName;
    };


    // Auto-select defaults if empty
    useEffect(() => {
        // Only auto-select metric if missing. Allow dimension to be empty (Total/Scalar view).
        if (!metric && metrics.length) setMetric(metrics.find(m => m.includes('revenue') || m.includes('sales')) || metrics[0]);
    }, [dataset]);

    // Cache for column values to prevent O(N) scan on every render
    const columnValuesCache = useRef<Record<string, string[]>>({});
    useEffect(() => { columnValuesCache.current = {}; }, [dataset]);

    const getColumnValues = (columnName: string): string[] => {
        if (!columnName || !dataset.rows.length) return [];

        // Return cached if available
        if (columnValuesCache.current[columnName]) {
            return columnValuesCache.current[columnName];
        }

        // Find actual key in data
        const row0 = dataset.rows[0];
        const actualKey = Object.keys(row0).find(k => k.toLowerCase() === columnName.toLowerCase()) || columnName;

        const uniqueValues = new Set<string>();
        // Limit scanning to first 10k rows for performance if needed, or scan all if critical
        const maxRows = 10000;
        const rowsToScan = dataset.rows.length > maxRows ? dataset.rows.slice(0, maxRows) : dataset.rows;

        rowsToScan.forEach(row => {
            const val = row[actualKey];
            if (val !== null && val !== undefined && val !== '') uniqueValues.add(String(val));
        });

        const values = Array.from(uniqueValues).sort().slice(0, 100);
        columnValuesCache.current[columnName] = values;
        return values;
    };

    const getDateValues = (columnName: string, grain: string, selectedParentValues: string[] = []): string[] => {
        if (!columnName || !dataset.rows.length) return [];

        // Create cache key including parent filter for hierarchical filtering
        const cacheKey = selectedParentValues.length > 0
            ? `${columnName}__${grain}__${selectedParentValues.sort().join('_')}`
            : `${columnName}__${grain}`;
        if (columnValuesCache.current[cacheKey]) {
            return columnValuesCache.current[cacheKey];
        }

        const row0 = dataset.rows[0];
        const actualKey = Object.keys(row0).find(k => k.toLowerCase() === columnName.toLowerCase()) || columnName;

        const uniqueValues = new Set<string>();
        const maxRows = 10000;
        const rowsToScan = dataset.rows.length > maxRows ? dataset.rows.slice(0, maxRows) : dataset.rows;

        rowsToScan.forEach(row => {
            const val = row[actualKey];
            if (!val || val === 'null' || val === 'undefined') return;

            const dateStr = String(val);

            // Parse date (handle various formats)
            let d: Date | null = null;
            if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
                const parts = dateStr.split('-').map(Number);
                d = new Date(parts[0], parts[1] - 1, parts[2], 12);
            } else if (dateStr.indexOf('/') > -1) {
                const parts = dateStr.split('/');
                if (parts.length === 3) {
                    d = new Date(Number(parts[2]), Number(parts[0]) - 1, Number(parts[1]), 12);
                }
            } else {
                d = new Date(dateStr);
            }

            if (d && !isNaN(d.getTime())) {
                const year = d.getFullYear();
                const month = d.getMonth() + 1;
                const day = d.getDate();
                const pad = (n: number) => n.toString().padStart(2, '0');

                // HIERARCHICAL FILTERING: Check if this date matches selected parent values
                if (selectedParentValues.length > 0) {
                    const firstParent = selectedParentValues[0];
                    let parentMatches = false;

                    if (firstParent.match(/^\d{4}$/)) {
                        // Parent is year format
                        parentMatches = selectedParentValues.includes(`${year}`);
                    } else if (firstParent.match(/^\d{4}-Q\d$/)) {
                        // Parent is quarter format
                        const q = Math.ceil(month / 3);
                        parentMatches = selectedParentValues.includes(`${year}-Q${q}`);
                    } else if (firstParent.match(/^\d{4}-\d{2}$/)) {
                        // Parent is month format
                        parentMatches = selectedParentValues.includes(`${year}-${pad(month)}`);
                    } else if (firstParent.match(/^\d{4}-W\d{2}$/)) {
                        // Parent is week format
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
                        const week = getISOWeek(d);
                        parentMatches = selectedParentValues.includes(`${year}-W${pad(week)}`);
                    }

                    // Skip this row if it doesn't match the parent filter
                    if (!parentMatches) return;
                }

                // Format value based on requested grain
                let formatted = '';
                if (grain === 'year') {
                    formatted = `${year}`;
                } else if (grain === 'quarter') {
                    const q = Math.ceil(month / 3);
                    formatted = `${year}-Q${q}`;
                } else if (grain === 'month') {
                    formatted = `${year}-${pad(month)}`;
                } else if (grain === 'week') {
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
                    const week = getISOWeek(d);
                    formatted = `${year}-W${pad(week)}`;
                } else if (grain === 'day') {
                    formatted = `${year}-${pad(month)}-${pad(day)}`;
                }

                if (formatted) uniqueValues.add(formatted);
            }
        });

        const values = Array.from(uniqueValues).sort();
        columnValuesCache.current[cacheKey] = values;
        return values;
    };


    const handleRun = () => {
        const dimensionFilters: Record<string, string[]> = {};
        const measureFilters: Array<{ column: string; operator: string; value: number }> = [];
        const dateFilters: Array<{ column: string; timeGrain: string; values: string[] }> = [];

        filters.forEach(f => {
            if (f.type === 'dimension' && f.column) {
                const values = Array.isArray(f.value) ? f.value : (f.value ? [f.value] : []);
                if (values.length > 0) {
                    dimensionFilters[f.column] = values;
                }
            } else if (f.type === 'measure' && f.column) {
                measureFilters.push({ column: f.column, operator: f.operator, value: f.value });
            } else if (!gafsOnly && f.type === 'date' && f.column) {
                const df = f as DateFilter;
                if (df.mode === 'range' && df.rangeStart && df.rangeEnd) {
                    // Range mode: pass as day-grain BETWEEN filter
                    dateFilters.push({ column: df.column, timeGrain: 'day', values: [`${df.rangeStart}__${df.rangeEnd}`] });
                } else if (df.values && df.values.length > 0) {
                    // Hierarchy mode: use the finest grain value set by DateFilterItem
                    dateFilters.push({ column: df.column, timeGrain: df.timeGrain || 'year', values: df.values });
                }
            }
        });

        // When both timeGrain and dimension are set, timeGrain is primary and column becomes secondary
        const allSecondaryDims = gafsOnly ? [] : [...secondaryDimensions];
        let activeDimension = gafsOnly ? dimension : (timeGrain || dimension);
        if (!gafsOnly && timeGrain && dimension && !allSecondaryDims.includes(dimension)) {
            allSecondaryDims.push(dimension);
        }

        // Presentation-only keys created by an AI SQL pivot (for example
        // "Metric" and "Value") are not physical dataset columns. A stale
        // handoff must never be allowed to compile them into DuckDB SQL.
        const resolvedFields = resolvePhysicalBuilderFields(dataset, {
            metric,
            dimension: activeDimension,
            secondaryMetrics: gafsOnly ? [] : secondaryMetrics,
            secondaryDimensions: allSecondaryDims,
        });
        if (!resolvedFields) return;

        const config: any = {
            metric: resolvedFields.metric,
            aggregation,
            dimension: resolvedFields.dimension,
            timeFilter: gafsOnly ? 'all_time' : timeFilter,
            filters: dimensionFilters,
            measureFilters,
            dateFilters,
            sort,
            limit,
            comparison: gafsOnly ? '' : comparison,
            comparisonGrain: !gafsOnly && comparison ? comparisonGrain : undefined,
            comparisonOffset: !gafsOnly && comparison ? comparisonOffset : undefined,
            ...(!gafsOnly && resolvedFields.secondaryMetrics.length > 0 ? { secondaryMetrics: resolvedFields.secondaryMetrics, axisMode: 'auto', secondaryMetricVisuals, secondaryMetricAggregations } : {}),
            ...(resolvedFields.secondaryDimensions.length > 0 ? { secondaryDimensions: resolvedFields.secondaryDimensions } : {})
        };

        onRunRef.current(config);
    };

    // Keep handleRunRef in sync for keyboard shortcut
    useEffect(() => { handleRunRef.current = handleRun; });

    // Auto-Run Effect
    useEffect(() => {
        if (metric) {
            // Check if we should skip this run (e.g. syncing from props)
            if (ignoreNextRun.current) {
                ignoreNextRun.current = false;
                return;
            }

            const timer = setTimeout(() => handleRun(), 400);
            return () => clearTimeout(timer);
        }
    }, [metric, aggregation, dimension, timeGrain, timeFilter, filters, sort, limit, comparison, comparisonGrain, comparisonOffset, secondaryMetrics, secondaryMetricVisuals, secondaryMetricAggregations, secondaryDimensions]);

    // (Auto-drill cascade removed — the new DateFilterItem handles hierarchy internally)

    // Filter Handlers
    const addFilter = (type: 'dimension' | 'measure' | 'date', column?: string, grain?: string) => {
        if (type === 'date') {
            setFilters([...filters, {
                id: nextFilterId,
                type: 'date',
                column: column || dateColumns[0] || '',
                mode: 'hierarchy',
                year: '',
                quarter: '',
                month: '',
                day: '',
                rangeStart: '',
                rangeEnd: '',
                timeGrain: 'year',
                values: []
            }]);
        } else if (type === 'dimension') {
            setFilters([...filters, {
                id: nextFilterId,
                type: 'dimension',
                column: dims.length ? dims[0] : '',
                value: []
            }]);
        } else {
            setFilters([...filters, {
                id: nextFilterId,
                type: 'measure',
                column: metric || (metrics.length ? metrics[0] : ''),
                operator: '>',
                value: 0
            }]);
        }
        setNextFilterId(nextFilterId + 1);
    };


    const removeFilter = (id: number) => setFilters(filters.filter(f => f.id !== id));

    const updateFilter = (id: number, field: string, value: any) => {
        setFilters(prevFilters => {
            const updatedFilters = prevFilters.map(f => {
                if (f.id === id) {
                    if (field === 'column' && f.type === 'dimension') {
                        return { ...f, [field]: value, value: [] };
                    }
                    return { ...f, [field]: value };
                }
                return f;
            });

            // (Recursive reset logic removed — hierarchy is managed within the single DateFilterItem)

            return updatedFilters;
        });
    };

    // The builder stays mounted to preserve the user's selections, but none of
    // its children may render while another route is active. This is essential
    // because dropdowns use document.body portals and otherwise escape the
    // hidden Builder container onto every application page.
    if (!isActive) return null;

    return (
        <div className="qi-question-builder max-w-7xl mx-auto px-6 pt-5 pb-4 bg-gradient-to-b from-slate-900 to-slate-800 rounded-2xl overflow-visible relative" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}>

            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
                <div className="flex flex-wrap items-center gap-1 rounded-xl border border-white/10 bg-slate-950/35 p-1">
                    {(gafsOnly ? [
                        { id: 'build', label: 'GAFS Edit', icon: Blocks },
                    ] : [
                        { id: 'build', label: 'Build', icon: Blocks },
                        { id: 'time', label: 'Time', icon: Clock },
                        { id: 'compare', label: 'Compare', icon: GitCompareArrows },
                        { id: 'calculations', label: 'Calculations', icon: Calculator },
                    ] as Array<{ id: BuilderTab; label: string; icon: React.ComponentType<{ className?: string }> }>).map(tab => {
                        const Icon = tab.icon;
                        const active = activeBuilderTab === tab.id;
                        return (
                            <button
                                key={tab.id}
                                type="button"
                                onClick={() => setActiveBuilderTab(tab.id)}
                                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${active
                                    ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-950/30'
                                    : 'text-slate-400 hover:bg-white/5 hover:text-white'}`}
                            >
                                <Icon className="h-3.5 w-3.5" />
                                {tab.label}
                                {tab.id === 'compare' && comparison && <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />}
                                {tab.id === 'calculations' && tableCalculations.length > 0 && (
                                    <span className="rounded-full bg-white/15 px-1.5 text-[9px]">{tableCalculations.length}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
                <div className="min-w-0 w-full text-left sm:w-auto sm:text-right">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">Current analysis</div>
                    <div className="max-w-[540px] whitespace-normal break-words text-xs font-semibold leading-5 text-slate-300">
                        {summaryText || 'Choose a metric to begin'}
                    </div>
                </div>
            </div>

            <div className="flex items-start justify-between w-full">
                {/* ═══════════════ PRIMARY ROW: THE CORE QUESTION ═══════════════ */}
                <div className="flex flex-wrap items-center gap-3 text-sm leading-snug flex-1 pr-4 pt-1 pb-1">
                    {activeBuilderTab === 'build' && (<>
                    <img src="/logo.jpg" alt="QuickInsight" className="w-5 h-5 rounded-md opacity-80" />
                    <span className="qi-builder-verb text-slate-200 text-base font-bold tracking-wide">Show me</span>

                    {/* Aggregation Selector */}
                    <div className="qi-builder-aggregation flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400/70 pl-1">Aggregation</span>
                        <Tooltip text={isDimensionMetric ? "Counting dimensions: Count tallies rows, Unique Count counts distinct values." : "How to aggregate the metric: Sum adds up values, Average calculates the mean, Count tallies rows, Unique Count counts distinct values."} position="bottom">
                            <QuerySelect
                                menuPlacement="auto"
                                value={aggregation}
                                onChange={setAggregation}
                                options={isDimensionMetric
                                    ? [
                                        { label: 'Count  (#)', value: 'COUNT' },
                                        { label: 'Unique Count  (∩)', value: 'COUNT_DISTINCT' },
                                        { label: 'Raw Values', value: 'NONE' }
                                    ]
                                    : [
                                        { label: 'Total  (Σ)', value: 'SUM' },
                                        { label: 'Average  (μ)', value: 'AVG' },
                                        { label: 'Highest  (↑)', value: 'MAX' },
                                        { label: 'Lowest  (↓)', value: 'MIN' },
                                        { label: 'Count  (#)', value: 'COUNT' },
                                        { label: 'Unique Count  (∩)', value: 'COUNT_DISTINCT' },
                                        { label: 'Raw Values', value: 'NONE' }
                                    ]}
                                icon={<span className="font-bold text-xs px-0.5">{isDimensionMetric ? '#' : 'Σ'}</span>}
                                colorTextClass="text-purple-400"
                                colorRingClass="focus:ring-purple-500/30"
                                searchable={false}
                            />
                        </Tooltip>
                    </div>

                    {/* Metric Selector */}
<div className="qi-builder-metric flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400/70 pl-1">Metric</span>
                        <Tooltip text="Choose the measure to analyze. Pick a numeric metric (e.g. revenue) or a dimension to count (e.g. patient count)." position="bottom">
                            <QuerySelect
                                menuPlacement="auto"
                                value={metric}
                                onChange={val => {
                                    setMetric(val);
                                    if (countableColumns.includes(val) && !['COUNT', 'COUNT_DISTINCT'].includes(aggregation)) {
                                        setAggregation('COUNT');
                                    }
                                }}
                                options={[
                                    ...metrics.map(m => ({ label: m.replace(/_/g, ' '), value: m, group: 'Measures' })),
                                    ...countableColumns.map(c => ({ label: c.replace(/_/g, ' '), value: c, group: 'Countable Dimensions' }))
                                ]}
                                icon={<TrendingUp className="w-3.5 h-3.5" />}
                                colorTextClass="text-purple-400"
                                colorRingClass="focus:ring-purple-500/30"
                                placeholder="Select Metric"
                            />
                        </Tooltip>
                    </div>

                    {/* Secondary Metric Chips (display only — add button moved to Options row) */}
                    {!gafsOnly && secondaryMetrics.map((sm, i) => (
                        <span key={sm} className="inline-flex items-center gap-1.5 bg-teal-500/20 text-teal-300 font-bold text-xs border border-teal-400/30 rounded-lg px-2.5 py-1.5 shadow-sm hover:scale-[1.02] transition-all relative overflow-visible">
                            <span className="text-teal-500 font-normal text-xs">+</span>
                            <span>{sm.replace(/_/g, ' ')}</span>
                            <span className="text-teal-400/40 mx-0.5">│</span>
                            <QuerySelect
                                menuPlacement="auto"
                                value={secondaryMetricAggregations[sm] || 'SUM'}
                                onChange={value => setSecondaryMetricAggregations(prev => ({ ...prev, [sm]: value }))}
                                options={[
                                    { label: 'Σ Total', value: 'SUM' },
                                    { label: 'μ Average', value: 'AVG' },
                                    { label: '↑ Highest', value: 'MAX' },
                                    { label: '↓ Lowest', value: 'MIN' },
                                    { label: '# Count', value: 'COUNT' },
                                    { label: '∩ Unique Count', value: 'COUNT_DISTINCT' },
                                ]}
                                colorTextClass="text-teal-300"
                                colorRingClass="focus:ring-teal-400/50"
                                searchable={false}
                                className="!py-1 !pl-2 !pr-1.5 !bg-teal-500/20 !border-teal-400/30"
                            />
                            <QuerySelect
                                menuPlacement="auto"
                                value={secondaryMetricVisuals[sm] || 'line'}
                                onChange={value => setSecondaryMetricVisuals(prev => ({ ...prev, [sm]: value }))}
                                options={[
                                    { label: '📈 Line', value: 'line' },
                                    { label: '📊 Bar', value: 'bar' },
                                    { label: '📉 Area', value: 'area' },
                                ]}
                                colorTextClass="text-teal-300"
                                colorRingClass="focus:ring-teal-400/50"
                                searchable={false}
                                className="!py-1 !pl-2 !pr-1.5 !bg-teal-500/20 !border-teal-400/30"
                            />
                            <button onClick={() => {
                                setSecondaryMetrics(prev => prev.filter((_, idx) => idx !== i));
                                setSecondaryMetricVisuals(prev => { const next = { ...prev }; delete next[sm]; return next; });
                                setSecondaryMetricAggregations(prev => { const next = { ...prev }; delete next[sm]; return next; });
                            }}
                                className="text-teal-400 hover:text-red-500 transition-colors ml-0.5">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </span>
                    ))}

                    {/* Secondary Dimension Chips */}
                    {!gafsOnly && secondaryDimensions.map((sd, i) => (
                        <span key={sd} className="inline-flex items-center gap-1 bg-violet-500/20 text-violet-300 font-bold text-xs border border-violet-400/30 rounded-lg px-2 py-1 shadow-sm hover:scale-[1.02] transition-all">
                            <Layers className="w-3 h-3 text-violet-400" />
                            <span>{sd.replace(/_/g, ' ')}</span>
                            <button onClick={() => setSecondaryDimensions(prev => prev.filter((_, idx) => idx !== i))}
                                className="text-violet-400 hover:text-red-500 transition-colors ml-0.5">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </span>
                    ))}

                    <span className="qi-builder-by text-slate-200 text-base font-bold tracking-wide">by</span>

                    {/* Dimension Selector (columns only) */}
                    <div className="qi-builder-dimension flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-400/70 pl-1">Dimension</span>
                        <Tooltip text="Group by a categorical column like product, region, or category." position="bottom">
                            <QuerySelect
                                menuPlacement="auto"
                                value={dimension}
                                onChange={newDim => {
                                    setDimension(newDim);
                                    if (newDim && !timeGrain) setSort('desc');
                                    // Remove any existing auto-filter for the old dimension
                                    setFilters(prev => prev.filter(f => !(f.type === 'dimension' && f._autoDim)));
                                }}
                                options={[
                                    { label: '(None)', value: '' },
                                    ...dims.map(d => ({ label: d.replace(/_/g, ' '), value: d, group: 'Dimensions' }))
                                ]}
                                icon={<MapPin className="w-3.5 h-3.5" />}
                                colorTextClass="text-blue-400"
                                colorRingClass="focus:ring-blue-500/30"
                                placeholder="Dimension"
                            />
                        </Tooltip>
                    </div>

                    {/* Dimension Value Picker — appears when dimension is selected */}
                    {dimension && (() => {
                        // Find or create the auto-filter for this dimension
                        const autoFilter = filters.find(
                            (f): f is DimensionFilter =>
                                f.type === 'dimension' && f.column === dimension && Boolean(f._autoDim)
                        );
                        const selectedValues: string[] = autoFilter ? (Array.isArray(autoFilter.value) ? autoFilter.value : []) : [];
                        const allValues = getColumnValues(dimension);
                        const isFiltered = selectedValues.length > 0 && selectedValues.length < allValues.length;

                        return (
                            <DimensionValuePicker
                                dimension={dimension}
                                allValues={allValues}
                                selectedValues={selectedValues}
                                isFiltered={isFiltered}
                                onToggleValue={(val: string) => {
                                    if (autoFilter) {
                                        const current = Array.isArray(autoFilter.value) ? autoFilter.value : [];
                                        const newVals = current.includes(val)
                                            ? current.filter((v: string) => v !== val)
                                            : [...current, val];
                                        updateFilter(autoFilter.id, 'value', newVals);
                                    } else {
                                        // Create new auto-filter
                                        setFilters(prev => [...prev, {
                                            id: nextFilterId,
                                            type: 'dimension' as const,
                                            column: dimension,
                                            value: [val],
                                            _autoDim: true
                                        }]);
                                        setNextFilterId(prev => prev + 1);
                                    }
                                }}
                                onSelectAll={() => {
                                    if (autoFilter) {
                                        // Remove the filter entirely (show all)
                                        removeFilter(autoFilter.id);
                                    }
                                }}
                                onClearAll={() => {
                                    if (autoFilter) {
                                        updateFilter(autoFilter.id, 'value', []);
                                    } else {
                                        setFilters(prev => [...prev, {
                                            id: nextFilterId,
                                            type: 'dimension' as const,
                                            column: dimension,
                                            value: [],
                                            _autoDim: true
                                        }]);
                                        setNextFilterId(prev => prev + 1);
                                    }
                                }}
                            />
                        );
                    })()}
                    </>)}

                    {/* Date/Time Grain Selector (separate) */}
                    {activeBuilderTab === 'time' && (<>
                    <div className="mr-2 max-w-[260px]">
                        <div className="text-sm font-black text-white">Time intelligence</div>
                        <div className="text-[11px] leading-4 text-slate-400">Choose the reporting grain and the period evaluated against the dataset’s AS OF date.</div>
                    </div>
                    <div className="qi-builder-time-grain flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400/70 pl-1">Time Grain</span>
                        <Tooltip text="Group by a time grain to see trends over time. Can be combined with a dimension." position="bottom">
                            <QuerySelect
                                menuPlacement="auto"
                                value={timeGrain}
                                onChange={newGrain => {
                                    setTimeGrain(newGrain);
                                    if (newGrain) setSort('oldest');
                                    else if (dimension) setSort('desc');
                                }}
                                options={[
                                    { label: '(None)', value: '' },
                                    { label: 'Minute', value: 'minute', group: 'Sub-Day' },
                                    { label: 'Hour', value: 'hour', group: 'Sub-Day' },
                                    { label: 'Day', value: 'day', group: 'Standard' },
                                    { label: 'Week', value: 'week', group: 'Standard' },
                                    { label: 'Month', value: 'month', group: 'Standard' },
                                    { label: 'Quarter', value: 'quarter', group: 'Standard' },
                                    { label: 'Year', value: 'year', group: 'Standard' },
                                ]}
                                icon={<Clock className="w-3.5 h-3.5" />}
                                colorTextClass="text-cyan-400"
                                colorRingClass="focus:ring-cyan-500/30"
                                placeholder="Date / Time"
                                searchable={false}
                            />
                        </Tooltip>
                    </div>

                    <span className="qi-builder-where text-slate-200 text-base font-bold tracking-wide">where</span>

                    {/* Time Filter */}
                    <div className="qi-builder-time-range flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400/70 pl-1">Time Range</span>
                        <div className="flex items-center gap-2">
                            <Tooltip text="Filter data by time range relative to the AS OF date. 'Time is Anything' includes all data. 'Last...' lets you pick a custom window." position="bottom">
                                <QuerySelect
                                    menuPlacement="auto"
                                    value={timeFilter.startsWith('last_') && !['last_30_days', 'last_90_days', 'last_year'].includes(timeFilter) ? 'custom' : timeFilter}
                                    onChange={val => {
                                        if (val === 'custom') setTimeFilter('last_7_days');
                                        else setTimeFilter(val);
                                    }}
                                    options={[
                                        { label: 'Time is Anything', value: 'all_time' },
                                        { label: 'Today', value: 'today', group: 'Preset' },
                                        { label: 'Yesterday', value: 'yesterday', group: 'Preset' },
                                        { label: 'Last 30 Days', value: 'last_30_days', group: 'Preset' },
                                        { label: 'Last 90 Days', value: 'last_90_days', group: 'Preset' },
                                        { label: 'This Week', value: 'this_week', group: 'Current' },
                                        { label: 'This Month', value: 'this_month', group: 'Current' },
                                        { label: 'This Quarter', value: 'this_quarter', group: 'Current' },
                                        { label: 'This Year', value: 'this_year', group: 'Current' },
                                        { label: 'Last...', value: 'custom', group: 'Custom' }
                                    ]}
                                    icon={<Calendar className="w-3.5 h-3.5" />}
                                    colorTextClass="text-green-400"
                                    colorRingClass="focus:ring-green-500/30"
                                    searchable={false}
                                />
                            </Tooltip>

                        {/* Custom Last N UI */}
                        {(timeFilter.startsWith('last_') && !['last_30_days', 'last_90_days', 'last_year'].includes(timeFilter)) && (
                            <div className="flex items-center gap-1 animate-in fade-in slide-in-from-left-2 duration-300">
                                <input
                                    type="number"
                                    min="1"
                                    value={timeFilter.split('_')[1]}
                                    onChange={e => {
                                        const n = parseInt(e.target.value) || 1;
                                        const unit = timeFilter.split('_')[2] || 'days';
                                        setTimeFilter(`last_${n}_${unit}`);
                                    }}
                                    className="w-16 bg-white/10 border-b-2 border-amber-400/50 rounded px-2 py-1 text-center font-bold text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                                />
                                <div className="relative inline-block">
                                    <QuerySelect
                                        menuPlacement="auto"
                                        value={timeFilter.split('_')[2] || 'days'}
                                        onChange={unit => {
                                            const n = timeFilter.split('_')[1] || '7';
                                            setTimeFilter(`last_${n}_${unit}`);
                                        }}
                                        options={[
                                            { label: 'Days', value: 'days' },
                                            { label: 'Weeks', value: 'weeks' },
                                            { label: 'Months', value: 'months' },
                                            { label: 'Years', value: 'years' },
                                        ]}
                                        colorTextClass="text-amber-300"
                                        colorRingClass="focus:ring-amber-400/50"
                                        searchable={false}
                                        className="!py-1 !pl-2 !pr-1.5 !bg-white/10 !border-amber-400/50"
                                    />
                                    <ChevronDown className="w-3 h-3 text-amber-400 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        )}
                        </div>
                    </div>
                    </>)}

                    {activeBuilderTab === 'compare' && (
                        <div className="flex w-full flex-wrap items-end gap-4 rounded-xl border border-amber-400/15 bg-amber-400/5 p-4">
                            <div className="mr-auto max-w-[300px]">
                                <div className="text-sm font-black text-white">Period comparison</div>
                                <div className="mt-1 text-[11px] leading-4 text-slate-400">Compare the current filtered period with its immediately preceding period or the same period farther back.</div>
                            </div>
                            <div className="flex flex-col gap-1">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-amber-400">Comparison</span>
                                <QuerySelect
                                    menuPlacement="auto"
                                    value={comparison}
                                    onChange={setComparison}
                                    options={[
                                        { label: 'No Comparison', value: '' },
                                        { label: 'vs Previous Period', value: 'previous_period' },
                                        { label: 'vs Same Period Last N', value: 'same_period_last_n' },
                                    ]}
                                    colorTextClass="text-yellow-400"
                                    colorRingClass="focus:ring-yellow-500/30"
                                    searchable={false}
                                />
                            </div>
                            {comparison === 'same_period_last_n' && (
                                <div className="flex flex-wrap items-center gap-1">
                                    {(['day', 'week', 'month', 'quarter', 'year'] as const).map(grain => (
                                        <button
                                            key={grain}
                                            type="button"
                                            onClick={() => setComparisonGrain(grain)}
                                            className={`rounded-md border px-2 py-1 text-xs font-bold ${comparisonGrain === grain
                                                ? 'border-amber-300/40 bg-amber-400/20 text-amber-200'
                                                : 'border-white/10 bg-white/5 text-slate-400'}`}
                                        >{grain[0].toUpperCase()}</button>
                                    ))}
                                    <button type="button" onClick={() => setComparisonOffset(Math.max(1, comparisonOffset - 1))} className="ml-2 h-7 w-7 rounded-md bg-white/10 text-white">−</button>
                                    <span className="min-w-6 text-center text-sm font-black text-white">{comparisonOffset}</span>
                                    <button type="button" onClick={() => setComparisonOffset(comparisonOffset + 1)} className="h-7 w-7 rounded-md bg-white/10 text-white">+</button>
                                </div>
                            )}
                            {comparison === 'previous_period' && timeFilter.startsWith('this_') && (
                                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-semibold text-slate-300">
                                    {timeFilter === 'this_week' ? 'This Week vs Last Week'
                                        : timeFilter === 'this_month' ? 'This Month vs Last Month'
                                            : timeFilter === 'this_quarter' ? 'This Quarter vs Last Quarter'
                                                : timeFilter === 'this_year' ? 'This Year vs Last Year'
                                                    : 'Current vs Previous'}
                                </span>
                            )}
                        </div>
                    )}

                    {activeBuilderTab === 'calculations' && (
                        <div className="w-full rounded-xl border border-fuchsia-400/15 bg-fuchsia-400/5 p-4">
                            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                <div>
                                    <div className="text-sm font-black text-white">Table calculations</div>
                                    <div className="mt-1 text-[11px] text-slate-400">Apply calculations to the aggregated result without rebuilding the core question.</div>
                                </div>
                                {tableCalculations.length > 0 && (
                                    <button type="button" onClick={() => onTableCalculationsChange?.([])} className="text-[11px] font-bold text-slate-400 hover:text-red-300">Clear all</button>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {([
                                    ['percent_of_total', '% of total'],
                                    ['rank_desc', 'Rank high to low'],
                                    ['rank_asc', 'Rank low to high'],
                                    ['running_total', 'Running total'],
                                    ['moving_avg', 'Moving average'],
                                    ['pct_diff_from_prev', '% change'],
                                    ['diff_from_prev', 'Difference'],
                                    ['percentile', 'Percentile'],
                                ] as Array<[TableCalculation, string]>).map(([calculation, label]) => {
                                    const selected = tableCalculations.includes(calculation);
                                    return (
                                        <button
                                            key={calculation}
                                            type="button"
                                            onClick={() => onTableCalculationsChange?.(selected
                                                ? tableCalculations.filter(item => item !== calculation)
                                                : [...tableCalculations, calculation])}
                                            className={`rounded-lg border px-3 py-2 text-xs font-bold transition-all ${selected
                                                ? 'border-fuchsia-300/40 bg-fuchsia-400/20 text-fuchsia-100'
                                                : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}`}
                                        >
                                            {selected && <Check className="mr-1 inline h-3 w-3" />}{label}
                                        </button>
                                    );
                                })}
                            </div>
                            {tableCalculations.includes('moving_avg') && (
                                <label className="mt-4 flex items-center gap-2 text-xs font-bold text-slate-300">
                                    Moving window
                                    <input
                                        type="number"
                                        min="2"
                                        max="50"
                                        value={movingAvgWindow}
                                        onChange={event => onMovingAvgWindowChange?.(Math.max(2, Number(event.target.value) || 3))}
                                        className="w-20 rounded-lg border border-white/10 bg-slate-950/50 px-2 py-1.5 text-center text-white outline-none focus:border-fuchsia-400/50"
                                    />
                                    periods
                                </label>
                            )}
                        </div>
                    )}

                </div>
                {/* ═══════════════ RIGHT CONTROLS: AS-OF, OPTIONS, FILTERS ═══════════════ */}
                {(activeBuilderTab === 'build' || activeBuilderTab === 'time') && (
                <div className="qi-builder-actions flex flex-col items-end gap-2 flex-shrink-0 relative z-[200]">
                    {/* Time anchor controls live in BuilderView’s top command bar. */}
                    <div className="qi-builder-action-row flex items-center gap-2">
                        {/* Options button */}
                        {activeBuilderTab === 'build' && <button
                            ref={optionsButtonRef}
                            onClick={() => setShowOptions(!showOptions)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase rounded-xl border transition-all duration-200 ${showOptions ? 'bg-white/15 border-white/20 text-white' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'}`}
                            title="Toggle options"
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            Options
                        </button>}

                        {/* ═══ Enhancement 3: Consolidated Filter Button ═══ */}
                        <div className="relative" ref={filterMenuRef}>
                            <button
                                ref={filterButtonRef}
                                onClick={() => setShowFilterMenu(!showFilterMenu)}
                                className={`flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase border rounded-xl px-3 py-1.5 transition-all duration-200 ${showFilterMenu || filters.length > 0 ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white'}`}
                            >
                                <Filter className="w-3.5 h-3.5" />
                                {filters.length > 0 ? `Filters (${filters.length})` : 'Add Filter'}
                            </button>

                            {showFilterMenu && ReactDOM.createPortal(
                                <div
                                    ref={filterPanelRef}
                                    className="qi-dropdown-surface qi-filter-menu fixed z-[9999] rounded-xl shadow-2xl border border-white/10 py-1 min-w-[200px] animate-in fade-in duration-200"
                                    style={{
                                        top: filterMenuPos.top,
                                        left: filterMenuPos.left,
                                        width: 240,
                                        backgroundColor: '#0f172a',
                                        transform: filterMenuPos.placement === 'up' ? 'translateY(-100%)' : 'none',
                                        transformOrigin: filterMenuPos.placement === 'up' ? 'bottom right' : 'top right'
                                    }}
                                >
                                    <button
                                        onClick={() => { addFilter('dimension'); setShowFilterMenu(false); }}
                                        className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-purple-500/20 hover:text-purple-300 flex items-center gap-2 transition-colors rounded-lg mx-0.5"
                                    >
                                        <span className="text-base">🏷️</span> By Dimension
                                        <span className="text-[10px] text-slate-500 ml-auto">category, region...</span>
                                    </button>
                                    <button
                                        onClick={() => { addFilter('measure'); setShowFilterMenu(false); }}
                                        className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-blue-500/20 hover:text-blue-300 flex items-center gap-2 transition-colors rounded-lg mx-0.5"
                                    >
                                        <span className="text-base">📊</span> By Metric Value
                                        <span className="text-[10px] text-slate-500 ml-auto">sales &gt; 1000...</span>
                                    </button>
                                    {!gafsOnly && dateColumns.length > 0 && (
                                        <button
                                            onClick={() => { addFilter('date'); setShowFilterMenu(false); }}
                                            className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-teal-500/20 hover:text-teal-300 flex items-center gap-2 transition-colors rounded-lg mx-0.5"
                                        >
                                            <span className="text-base">📅</span> By Date
                                            <span className="text-[10px] text-slate-500 ml-auto">year, quarter...</span>
                                        </button>
                                    )}
                                </div>,
                                document.body
                            )}
                        </div>
                    </div>
                </div>
                )}
            </div>

            {/* ═══════════════ ROW 2: SECONDARY CONTROLS (Always visible) ═══════════════ */}
            {activeBuilderTab === 'build' && showOptions && ReactDOM.createPortal(
                <div
                    className="qi-dropdown-surface qi-builder-options-panel fixed z-[9999] flex flex-wrap items-center gap-4 rounded-xl border border-white/15 p-4 text-sm shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200"
                    style={{
                        top: optionsPos.top,
                        left: optionsPos.left,
                        width: 'min(360px, calc(100vw - 16px))',
                        maxHeight: optionsPos.maxHeight,
                        overflowY: 'auto',
                        transform: optionsPos.placement === 'up' ? 'translateY(-100%)' : 'none',
                        transformOrigin: optionsPos.placement === 'up' ? 'bottom left' : 'top left',
                    }}
                >
                    {/* METRIC */}
                    {!gafsOnly && metrics.filter(m => m !== metric && !secondaryMetrics.includes(m)).length > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-purple-400 uppercase tracking-wider font-bold">Metric</span>
                            <QuerySelect
                                menuPlacement="auto"
                                value=""
                                onChange={val => { if (val) setSecondaryMetrics(prev => [...prev, val]); }}
                                options={[
                                    { label: '+ Add Metric', value: '' },
                                    ...metrics.filter(m => m !== metric && !secondaryMetrics.includes(m)).map(m => ({ label: m.replace(/_/g, ' '), value: m }))
                                ]}
                                icon={<span className="text-xl leading-none -mt-1 font-normal">+</span>}
                                colorTextClass="text-purple-400"
                                colorRingClass="focus:ring-purple-500/30"
                                placeholder="+ Add Metric"
                            />
                        </div>
                    )}

                    {/* DIMENSION */}
                    {!gafsOnly && dims.filter(d => d !== dimension && !secondaryDimensions.includes(d)).length > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-blue-400 uppercase tracking-wider font-bold">Dimension</span>
                            <QuerySelect
                                menuPlacement="auto"
                                value=""
                                onChange={val => { if (val) setSecondaryDimensions(prev => [...prev, val]); }}
                                options={[
                                    { label: '+ Add Dimension', value: '' },
                                    ...dims.filter(d => d !== dimension && !secondaryDimensions.includes(d)).map(d => ({ label: d.replace(/_/g, ' '), value: d }))
                                ]}
                                icon={<span className="text-xl leading-none -mt-1 font-normal">+</span>}
                                colorTextClass="text-blue-400"
                                colorRingClass="focus:ring-blue-500/30"
                                placeholder="+ Add Dimension"
                            />
                        </div>
                    )}

                    {/* LIMIT — Top / Bottom */}
                    {!isTimeDimension && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400 uppercase tracking-wider font-bold">Limit</span>
                            <QuerySelect
                                menuPlacement="auto"
                                value={(() => {
                                    if (limit === 0) return '0';
                                    const isBottom = sort === 'asc';
                                    const absLimit = Math.abs(limit);
                                    if ([5, 10, 20, 50].includes(absLimit)) return isBottom ? `-${absLimit}` : `${absLimit}`;
                                    return 'custom';
                                })()}
                                onChange={val => {
                                    if (val === 'custom') {
                                        setCustomLimitDraft('15');
                                        setLimit(15);
                                        setSort('desc');
                                    }
                                    else {
                                        const n = Number(val);
                                        if (n === 0) { setLimit(0); }
                                        else if (n < 0) { setLimit(Math.abs(n)); setSort('asc'); }
                                        else { setLimit(n); setSort('desc'); }
                                    }
                                }}
                                options={[
                                    { label: 'Show All', value: '0' },
                                    { label: '\u2B06 Top 5', value: '5' },
                                    { label: '\u2B06 Top 10', value: '10' },
                                    { label: '\u2B06 Top 20', value: '20' },
                                    { label: '\u2B06 Top 50', value: '50' },
                                    { label: '\u2B07 Bottom 5', value: '-5' },
                                    { label: '\u2B07 Bottom 10', value: '-10' },
                                    { label: '\u2B07 Bottom 20', value: '-20' },
                                    { label: '\u2B07 Bottom 50', value: '-50' },
                                    { label: 'Custom...', value: 'custom' }
                                ]}
                                colorRingClass="focus:ring-white/20"
                                searchable={false}
                            />

                            {/* Custom Top N Input */}
                            {(limit > 0 && ![5, 10, 20, 50].includes(limit)) && (
                                <input
                                    type="number"
                                    min="1"
                                    max="10000"
                                    step="1"
                                    value={customLimitDraft}
                                    onChange={e => {
                                        const raw = e.target.value;
                                        setCustomLimitDraft(raw);
                                        if (/^\d+$/.test(raw)) {
                                            const parsed = Number.parseInt(raw, 10);
                                            if (parsed >= 1 && parsed <= 10_000) setLimit(parsed);
                                        }
                                    }}
                                    onBlur={e => commitCustomLimit(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') {
                                            commitCustomLimit(e.currentTarget.value);
                                            e.currentTarget.blur();
                                        }
                                    }}
                                    aria-label="Custom result limit"
                                    className="w-16 bg-white/5 border border-white/10 rounded-xl px-2 py-1.5 text-center font-semibold text-white focus:outline-none focus:ring-2 focus:ring-white/20 text-sm"
                                />
                            )}
                        </div>
                    )}

                    {/* SORT */}
                    {!isTimeDimension && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-amber-400 uppercase tracking-wider font-bold">Sort</span>
                            <QuerySelect
                                menuPlacement="auto"
                                value={sort}
                                onChange={val => setSort(val as 'asc' | 'desc' | 'oldest' | 'newest')}
                                options={[
                                    { label: 'High to Low', value: 'desc' },
                                    { label: 'Low to High', value: 'asc' },
                                    { label: 'Oldest First', value: 'oldest' },
                                    { label: 'Newest First', value: 'newest' }
                                ]}
                                colorTextClass="text-amber-400"
                                colorRingClass="focus:ring-amber-500/30"
                                searchable={false}
                            />
                        </div>
                    )}
                </div>,
                document.body
            )}

            {/* ═══ Active Filters Row ═══ */}
            {filters.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-white/10">
                    {filters.map(filter => {
                        if (!gafsOnly && filter.type === 'date') {
                            return (
                                <DateFilterItem
                                    key={filter.id}
                                    id={filter.id}
                                    filter={filter}
                                    dateColumns={dateColumns}
                                    getDateValues={getDateValues}
                                    onUpdate={updateFilter}
                                    onRemove={removeFilter}
                                />
                            );
                        }
                        return (
                            <FilterItem
                                key={filter.id}
                                id={filter.id}
                                filter={filter}
                                dims={dims}
                                metrics={metrics}
                                getColumnValues={getColumnValues}
                                onUpdate={updateFilter}
                                onRemove={removeFilter}
                            />
                        );
                    })}
                </div>
            )}
        </div>
    );
};

/**
 * Inline dimension value picker — shows a clickable chip next to the dimension selector.
 * Opens a portalled multi-select dropdown to pick which values to include.
 */
const DimensionValuePicker: React.FC<{
    dimension: string;
    allValues: string[];
    selectedValues: string[];
    isFiltered: boolean;
    onToggleValue: (val: string) => void;
    onSelectAll: () => void;
    onClearAll: () => void;
}> = ({ dimension, allValues, selectedValues, isFiltered, onToggleValue, onSelectAll, onClearAll }) => {
    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState('');
    const btnRef = React.useRef<HTMLButtonElement>(null);
    const dropRef = React.useRef<HTMLDivElement>(null);
    const [pos, setPos] = React.useState<{
        top: number;
        left: number;
        maxHeight: number;
        placement: 'up' | 'down';
    }>({ top: 0, left: 0, maxHeight: 300, placement: 'down' });

    React.useEffect(() => {
        if (!open) return;
        const handle = (e: MouseEvent) => {
            if (dropRef.current && !dropRef.current.contains(e.target as Node) &&
                btnRef.current && !btnRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handle);
        return () => document.removeEventListener('mousedown', handle);
    }, [open]);

    React.useEffect(() => {
        if (!open || !btnRef.current) return;
        const updatePosition = () => {
            const r = btnRef.current?.getBoundingClientRect();
            if (!r) return;
            const gap = 6;
            const viewportPadding = 8;
            const desiredHeight = 300;
            const availableAbove = Math.max(0, r.top - viewportPadding - gap);
            const availableBelow = Math.max(0, window.innerHeight - r.bottom - viewportPadding - gap);
            const placement: 'up' | 'down' =
                availableBelow >= desiredHeight || availableBelow >= availableAbove ? 'down' : 'up';
            const availableHeight = placement === 'up' ? availableAbove : availableBelow;
            const menuWidth = Math.min(320, Math.max(r.width, 220));
            setPos({
                top: placement === 'up' ? r.top - gap : r.bottom + gap,
                left: Math.max(viewportPadding, Math.min(r.left, window.innerWidth - menuWidth - viewportPadding)),
                maxHeight: Math.max(96, Math.min(desiredHeight, availableHeight)),
                placement
            });
        };
        updatePosition();
        window.addEventListener('resize', updatePosition);
        window.addEventListener('scroll', updatePosition, true);
        return () => {
            window.removeEventListener('resize', updatePosition);
            window.removeEventListener('scroll', updatePosition, true);
        };
    }, [open]);

    const filtered = allValues.filter(v => v.toLowerCase().includes(search.toLowerCase()));
    const label = !isFiltered
        ? `All (${allValues.length})`
        : `${selectedValues.length} of ${allValues.length}`;

    return (
        <div className="relative inline-block">
            <button
                ref={btnRef}
                onClick={() => setOpen(!open)}
                className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold border transition-all cursor-pointer ${
                    isFiltered
                        ? 'bg-blue-500/20 text-blue-300 border-blue-400/30 hover:bg-blue-500/30'
                        : 'bg-white/5 text-slate-400 border-white/10 hover:bg-white/10 hover:text-slate-300'
                }`}
                title={`Pick which ${dimension.replace(/_/g, ' ')} values to include`}
            >
                <Filter className="w-3 h-3" />
                {label}
                <ChevronDown className="w-3 h-3 opacity-60" />
            </button>

            {open && ReactDOM.createPortal(
                <div
                    ref={dropRef}
                    className="qi-dropdown-surface qi-dimension-value-menu fixed z-[9999] rounded-xl shadow-2xl border border-blue-400/30 overflow-hidden"
                    style={{
                        top: pos.top,
                        left: pos.left,
                        minWidth: 220,
                        maxWidth: 320,
                        maxHeight: pos.maxHeight,
                        overflow: 'hidden',
                        backgroundColor: '#0f172a',
                        transform: pos.placement === 'up' ? 'translateY(-100%)' : 'none',
                        transformOrigin: pos.placement === 'up' ? 'bottom left' : 'top left'
                    }}
                >
                    {/* Search */}
                    <div className="px-2 pt-2 pb-1 border-b border-white/10">
                        <div className="relative">
                            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2" style={{ color: '#94a3b8' }} />
                            <input
                                type="text"
                                placeholder={`Search ${dimension.replace(/_/g, ' ')}...`}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                className="w-full pl-7 pr-2 py-1.5 text-xs rounded border border-white/15 focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder-slate-500"
                                style={{ backgroundColor: 'rgba(255,255,255,0.1)', color: '#e2e8f0' }}
                                onClick={e => e.stopPropagation()}
                            />
                        </div>
                    </div>

                    {/* Select All / Clear All */}
                    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-white/10">
                        <button
                            onClick={() => onSelectAll()}
                            className="text-[10px] font-bold px-2 py-0.5 rounded hover:bg-white/10 transition-colors"
                            style={{ color: '#94a3b8' }}
                        >
                            Select All
                        </button>
                        <span style={{ color: '#334155' }}>│</span>
                        <button
                            onClick={() => onClearAll()}
                            className="text-[10px] font-bold px-2 py-0.5 rounded hover:bg-red-500/20 transition-colors"
                            style={{ color: '#f87171' }}
                        >
                            Clear All
                        </button>
                    </div>

                    {/* Values list */}
                    <div className="overflow-auto" style={{ maxHeight: Math.max(44, pos.maxHeight - 92) }}>
                        {filtered.length === 0 ? (
                            <div className="px-3 py-2 text-xs" style={{ color: '#94a3b8' }}>No matches</div>
                        ) : (
                            filtered.map(val => {
                                const isChecked = selectedValues.includes(val);
                                // When no filter is active (selectedValues empty), show all as "included"
                                const showAsIncluded = selectedValues.length === 0 || isChecked;
                                return (
                                    <button
                                        key={val}
                                        onClick={() => onToggleValue(val)}
                                        className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${
                                            showAsIncluded ? 'hover:bg-blue-500/20' : 'hover:bg-white/10'
                                        }`}
                                        style={{ color: showAsIncluded ? '#e2e8f0' : '#64748b' }}
                                    >
                                        <span
                                            className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0"
                                            style={{
                                                borderColor: showAsIncluded ? '#60a5fa' : '#475569',
                                                backgroundColor: showAsIncluded ? 'rgba(96,165,250,0.2)' : 'transparent'
                                            }}
                                        >
                                            {showAsIncluded && <Check className="w-3 h-3" style={{ color: '#60a5fa' }} />}
                                        </span>
                                        <span className="truncate">{val}</span>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};

