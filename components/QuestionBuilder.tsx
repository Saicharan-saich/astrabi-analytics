import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { ChevronDown, Plus, Calendar, Settings, ArrowUpDown, Filter, X, TrendingUp, List, Hash, SlidersHorizontal, Layers, MapPin, Clock, Check, Search } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { FilterItem } from './FilterItem';
import { DateFilterItem } from './DateFilterItem';
import { Tooltip } from './Tooltip';
import { QuerySelect } from './QuerySelect';

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
    asOfDate: string;
    onDateChange: (date: string) => void;
    anchorColumn?: string;
    onAnchorColumnChange?: (col: string) => void;
}

interface DimensionFilter {
    id: number;
    type: 'dimension';
    column: string;
    value: string | string[]; // Support both single and multi-select
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
    year?: string;
    quarter?: string;
    month?: string;
    day?: string;
    // Range mode selections
    rangeStart?: string;
    rangeEnd?: string;
    // Computed by DateFilterItem for downstream use
    timeGrain?: string;
    values?: string[];
}

type Filter = DimensionFilter | MeasureFilter | DateFilter;

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
    asOfDate,
    onDateChange,
    anchorColumn,
    onAnchorColumnChange
}) => {
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

    const [filters, setFilters] = useState<Filter[]>([]);
    const [nextFilterId, setNextFilterId] = useState(1);

    // Secondary metrics for combo/dual-axis charts
    const [secondaryMetrics, setSecondaryMetrics] = useState<string[]>(initialSecondaryMetrics);
    const [secondaryMetricVisuals, setSecondaryMetricVisuals] = useState<Record<string, string>>(initialSecondaryMetricVisuals);
    const [secondaryMetricAggregations, setSecondaryMetricAggregations] = useState<Record<string, string>>(initialSecondaryMetricAggregations);

    // Secondary dimensions for multi-dimension grouping
    const [secondaryDimensions, setSecondaryDimensions] = useState<string[]>([]);

    // Comparison state
    const [comparison, setComparison] = useState<string>(initialComparison);
    const [comparisonGrain, setComparisonGrain] = useState<string>(initialComparisonGrain);
    const [comparisonOffset, setComparisonOffset] = useState<number>(initialComparisonOffset);

    // UI Enhancement states
    const [showOptions, setShowOptions] = useState(false);
    const [showFilterMenu, setShowFilterMenu] = useState(false);
    const filterMenuRef = useRef<HTMLDivElement>(null);

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

    // Close filter menu on outside click
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (filterMenuRef.current && !filterMenuRef.current.contains(e.target as Node)) {
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

    // Initial Syncer
    useEffect(() => {
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
        if (initialSort) setSort(initialSort);

        // Prevent the auto-run effect from firing immediately after this sync
        // because the parent (Workbench) has already run the correct analysis.
        ignoreNextRun.current = true;
    }, [initialMetric, initialDimension, initialTimeFilter, initialLimit, initialSort]);

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
            } else if (f.type === 'date' && f.column) {
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
        const allSecondaryDims = [...secondaryDimensions];
        let activeDimension = timeGrain || dimension;
        if (timeGrain && dimension && !allSecondaryDims.includes(dimension)) {
            allSecondaryDims.push(dimension);
        }

        const config: any = {
            metric,
            aggregation,
            dimension: activeDimension,
            timeFilter,
            filters: dimensionFilters,
            measureFilters,
            dateFilters,
            sort,
            limit,
            comparison: comparison,
            comparisonGrain: comparison ? comparisonGrain : undefined,
            comparisonOffset: comparison ? comparisonOffset : undefined,
            ...(secondaryMetrics.length > 0 ? { secondaryMetrics, axisMode: 'auto', secondaryMetricVisuals, secondaryMetricAggregations } : {}),
            ...(allSecondaryDims.length > 0 ? { secondaryDimensions: allSecondaryDims } : {})
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

    return (
        <div className="max-w-7xl mx-auto px-6 pt-5 pb-4 bg-gradient-to-b from-slate-900 to-slate-800 rounded-2xl overflow-visible relative" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.2)' }}>

            <div className="flex items-start justify-between w-full">
                {/* ═══════════════ PRIMARY ROW: THE CORE QUESTION ═══════════════ */}
                <div className="flex flex-wrap items-center gap-3 text-sm leading-snug flex-1 pr-4 pt-1 pb-1">
                    <img src="/logo.jpg" alt="QuickInsight" className="w-5 h-5 rounded-md opacity-80" />
                    <span className="text-slate-200 text-base font-bold tracking-wide">Show me</span>

                    {/* Metric Selector */}
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400/70 pl-1">Metric</span>
                        <Tooltip text="Choose the measure to analyze. Pick a numeric metric (e.g. revenue) or a dimension to count (e.g. patient count)." position="bottom">
                            <QuerySelect
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

                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-400/70 pl-1">Aggregation</span>
                        <Tooltip text={isDimensionMetric ? "Counting dimensions: Count tallies rows, Unique Count counts distinct values." : "How to aggregate the metric: Sum adds up values, Average calculates the mean, Count tallies rows, Unique Count counts distinct values."} position="bottom">
                            <QuerySelect
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

                    {/* Secondary Metric Chips (display only — add button moved to Options row) */}
                    {secondaryMetrics.map((sm, i) => (
                        <span key={sm} className="inline-flex items-center gap-1.5 bg-teal-500/20 text-teal-300 font-bold text-xs border border-teal-400/30 rounded-lg px-2.5 py-1.5 shadow-sm hover:scale-[1.02] transition-all relative overflow-visible">
                            <span className="text-teal-500 font-normal text-xs">+</span>
                            <span>{sm.replace(/_/g, ' ')}</span>
                            <span className="text-teal-400/40 mx-0.5">│</span>
                            <select
                                value={secondaryMetricAggregations[sm] || 'SUM'}
                                onChange={e => setSecondaryMetricAggregations(prev => ({ ...prev, [sm]: e.target.value }))}
                                className="bg-teal-500/20 text-teal-200 text-xs font-bold rounded-md border border-teal-400/30 pl-1.5 pr-5 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-teal-400/50 hover:bg-teal-500/30 transition-colors appearance-none"
                                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', backgroundSize: '12px' }}
                                title="Aggregation for this metric"
                            >
                                <option value="SUM" className="bg-white text-gray-900">Σ Total</option>
                                <option value="AVG" className="bg-white text-gray-900">μ Average</option>
                                <option value="MAX" className="bg-white text-gray-900">↑ Highest</option>
                                <option value="MIN" className="bg-white text-gray-900">↓ Lowest</option>
                                <option value="COUNT" className="bg-white text-gray-900"># Count</option>
                                <option value="COUNT_DISTINCT" className="bg-white text-gray-900">∩ Unique Count</option>
                            </select>
                            <select
                                value={secondaryMetricVisuals[sm] || 'line'}
                                onChange={e => setSecondaryMetricVisuals(prev => ({ ...prev, [sm]: e.target.value }))}
                                className="bg-teal-500/20 text-teal-200 text-xs font-bold rounded-md border border-teal-400/30 pl-1.5 pr-5 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-teal-400/50 hover:bg-teal-500/30 transition-colors appearance-none"
                                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 4px center', backgroundSize: '12px' }}
                                title="Visual type for this metric"
                            >
                                <option value="line" className="bg-white text-gray-900">📈 Line</option>
                                <option value="bar" className="bg-white text-gray-900">📊 Bar</option>
                                <option value="area" className="bg-white text-gray-900">📉 Area</option>
                            </select>
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
                    {secondaryDimensions.map((sd, i) => (
                        <span key={sd} className="inline-flex items-center gap-1 bg-violet-500/20 text-violet-300 font-bold text-xs border border-violet-400/30 rounded-lg px-2 py-1 shadow-sm hover:scale-[1.02] transition-all">
                            <Layers className="w-3 h-3 text-violet-400" />
                            <span>{sd.replace(/_/g, ' ')}</span>
                            <button onClick={() => setSecondaryDimensions(prev => prev.filter((_, idx) => idx !== i))}
                                className="text-violet-400 hover:text-red-500 transition-colors ml-0.5">
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </span>
                    ))}

                    <span className="text-slate-200 text-base font-bold tracking-wide">by</span>

                    {/* Dimension Selector (columns only) */}
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-blue-400/70 pl-1">Dimension</span>
                        <Tooltip text="Group by a categorical column like product, region, or category." position="bottom">
                            <QuerySelect
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
                        const autoFilter = filters.find(f => f.type === 'dimension' && f.column === dimension && f._autoDim);
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

                    {/* Date/Time Grain Selector (separate) */}
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400/70 pl-1">Time Grain</span>
                        <Tooltip text="Group by a time grain to see trends over time. Can be combined with a dimension." position="bottom">
                            <QuerySelect
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

                    <span className="text-slate-200 text-base font-bold tracking-wide">where</span>

                    {/* Time Filter */}
                    <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400/70 pl-1">Time Range</span>
                        <div className="flex items-center gap-2">
                            <Tooltip text="Filter data by time range relative to the AS OF date. 'Time is Anything' includes all data. 'Last...' lets you pick a custom window." position="bottom">
                                <QuerySelect
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
                                    <select
                                        value={timeFilter.split('_')[2] || 'days'}
                                        onChange={e => {
                                            const n = timeFilter.split('_')[1] || '7';
                                            const unit = e.target.value;
                                            setTimeFilter(`last_${n}_${unit}`);
                                        }}
                                        className="appearance-none bg-white/10 border-b-2 border-amber-400/50 rounded px-2 py-1 font-bold text-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-400/50"
                                    >
                                        <option value="days">Days</option>
                                        <option value="weeks">Weeks</option>
                                        <option value="months">Months</option>
                                        <option value="years">Years</option>
                                    </select>
                                    <ChevronDown className="w-3 h-3 text-amber-400 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        )}
                        </div>
                    </div>

                </div>
                {/* ═══════════════ RIGHT CONTROLS: AS-OF, OPTIONS, FILTERS ═══════════════ */}
                <div className="flex flex-col items-end gap-2 flex-shrink-0 relative z-[200]">
                    <div className="flex items-center gap-2">
                        {dataset.timeContext?.dateColumnMaxDates && Object.keys(dataset.timeContext.dateColumnMaxDates).length > 1 && (
                            <Tooltip text="Choose which date column drives the time anchor." position="bottom">
                                <QuerySelect
                                    value={anchorColumn || dataset.timeContext?.anchorDateColumn || ''}
                                    onChange={(newAnchor) => { if (newAnchor) onAnchorColumnChange?.(newAnchor) }}
                                    options={Object.keys(dataset.timeContext.dateColumnMaxDates).map(col => ({
                                        label: col.replace(/_/g, ' '),
                                        value: col
                                    }))}
                                    colorTextClass="text-slate-400"
                                    colorRingClass="focus:ring-white/20"
                                    searchable={false}
                                />
                            </Tooltip>
                        )}
                        <Tooltip text="As of date — defines what 'today' means for time queries." position="bottom">
                            <span className="flex items-center gap-1.5 bg-white/5 rounded-xl px-3 py-1.5 border border-white/10 hover:bg-white/8 transition-colors cursor-pointer text-sm">
                                <Calendar className="w-4 h-4 text-slate-400" />
                                <span className="text-slate-400 font-semibold text-xs">As of:</span>
                                <input
                                    type="date"
                                    value={asOfDate}
                                    onChange={(e) => onDateChange(e.target.value)}
                                    className="font-bold text-white bg-transparent border-none focus:ring-0 cursor-pointer p-0 w-[110px]"
                                />
                            </span>
                        </Tooltip>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Options button */}
                        <button
                            onClick={() => setShowOptions(!showOptions)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold tracking-wider uppercase rounded-xl border transition-all duration-200 ${showOptions ? 'bg-white/15 border-white/20 text-white' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10 hover:text-white'}`}
                            title="Toggle options"
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            Options
                        </button>

                        {/* ═══ Enhancement 3: Consolidated Filter Button ═══ */}
                        <div className="relative" ref={filterMenuRef}>
                            <button
                                onClick={() => setShowFilterMenu(!showFilterMenu)}
                                className={`flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase border rounded-xl px-3 py-1.5 transition-all duration-200 ${showFilterMenu || filters.length > 0 ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white'}`}
                            >
                                <Filter className="w-3.5 h-3.5" />
                                {filters.length > 0 ? `Filters (${filters.length})` : 'Add Filter'}
                            </button>

                            {showFilterMenu && (
                                <div className="absolute top-full right-0 mt-1 rounded-xl shadow-2xl border border-white/10 py-1 z-50 min-w-[200px] animate-in fade-in slide-in-from-top-2 duration-200" style={{ backgroundColor: '#0f172a' }}>
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
                                    {dateColumns.length > 0 && (
                                        <button
                                            onClick={() => { addFilter('date'); setShowFilterMenu(false); }}
                                            className="w-full text-left px-3 py-2.5 text-sm font-medium text-slate-300 hover:bg-teal-500/20 hover:text-teal-300 flex items-center gap-2 transition-colors rounded-lg mx-0.5"
                                        >
                                            <span className="text-base">📅</span> By Date
                                            <span className="text-[10px] text-slate-500 ml-auto">year, quarter...</span>
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* ═══════════════ ROW 2: SECONDARY CONTROLS (Always visible) ═══════════════ */}
            {showOptions && (
                <div className="flex flex-wrap items-center gap-4 mt-4 pt-3 border-t border-white/5 text-sm animate-in fade-in slide-in-from-top-2 duration-200">
                    {/* METRIC */}
                    {metrics.filter(m => m !== metric && !secondaryMetrics.includes(m)).length > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-purple-400 uppercase tracking-wider font-bold">Metric</span>
                            <QuerySelect
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
                    {dims.filter(d => d !== dimension && !secondaryDimensions.includes(d)).length > 0 && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-blue-400 uppercase tracking-wider font-bold">Dimension</span>
                            <QuerySelect
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

                    {/* COMPARE */}
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-yellow-400 uppercase tracking-wider font-bold">Compare</span>
                        <QuerySelect
                            value={comparison}
                            onChange={setComparison}
                            options={[
                                { label: 'No Comparison', value: '' },
                                { label: 'vs Previous Period', value: 'previous_period' },
                                { label: 'vs Same Period Last N', value: 'same_period_last_n' }
                            ]}
                            colorTextClass="text-yellow-400"
                            colorRingClass="focus:ring-yellow-500/30"
                            searchable={false}
                        />

                        {/* Grain + Offset for Same Period Last N */}
                        {comparison === 'same_period_last_n' && (
                            <div className="flex items-center gap-1 animate-in fade-in slide-in-from-left-2 duration-300">
                                {(['day', 'week', 'month', 'quarter', 'year'] as const).map(g => (
                                    <button
                                        key={g}
                                        onClick={() => setComparisonGrain(g)}
                                        className={`px-2 py-0.5 rounded-md text-xs font-bold transition-all border ${comparisonGrain === g
                                            ? 'bg-white/15 text-white border-white/20'
                                            : 'bg-white/5 text-slate-400 border-white/10 hover:bg-white/10'
                                            }`}
                                    >
                                        {g[0].toUpperCase()}
                                    </button>
                                ))}
                                <div className="flex items-center gap-0.5 ml-1">
                                    <button
                                        onClick={() => setComparisonOffset(Math.max(1, comparisonOffset - 1))}
                                        className="w-5 h-5 rounded bg-white/10 text-white font-bold text-xs flex items-center justify-center hover:bg-white/15 transition-all"
                                    >−</button>
                                    <span className="text-xs font-bold text-white min-w-[1.2rem] text-center">{comparisonOffset}</span>
                                    <button
                                        onClick={() => setComparisonOffset(comparisonOffset + 1)}
                                        className="w-5 h-5 rounded bg-white/10 text-white font-bold text-xs flex items-center justify-center hover:bg-white/15 transition-all"
                                    >+</button>
                                </div>
                                <span className="text-[10px] font-semibold text-slate-400 ml-1 whitespace-nowrap">
                                    (Last {comparisonOffset} {comparisonGrain}{comparisonOffset > 1 ? 's' : ''})
                                </span>
                            </div>
                        )}

                        {/* Quick comparison hint */}
                        {comparison === 'previous_period' && timeFilter.startsWith('this_') && (
                            <span className="text-[10px] font-semibold text-slate-300 bg-white/5 px-2 py-0.5 rounded-full border border-white/10">
                                {timeFilter === 'this_week' ? 'This Week vs Last Week'
                                    : timeFilter === 'this_month' ? 'This Month vs Last Month'
                                        : timeFilter === 'this_quarter' ? 'This Quarter vs Last Quarter'
                                            : timeFilter === 'this_year' ? 'This Year vs Last Year'
                                                : 'Current vs Previous'}
                            </span>
                        )}
                    </div>

                    {/* LIMIT — Top / Bottom */}
                    {!isTimeDimension && (
                        <div className="flex items-center gap-2">
                            <span className="text-xs text-slate-400 uppercase tracking-wider font-bold">Limit</span>
                            <QuerySelect
                                value={(() => {
                                    if (limit === 0) return '0';
                                    const isBottom = sort === 'asc';
                                    const absLimit = Math.abs(limit);
                                    if ([5, 10, 20, 50].includes(absLimit)) return isBottom ? `-${absLimit}` : `${absLimit}`;
                                    return 'custom';
                                })()}
                                onChange={val => {
                                    if (val === 'custom') { setLimit(15); setSort('desc'); }
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
                                    value={limit}
                                    onChange={e => setLimit(parseInt(e.target.value) || 1)}
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
                </div>
            )}

            {/* ═══ Active Filters Row ═══ */}
            {filters.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-white/10">
                    {filters.map(filter => {
                        if (filter.type === 'date') {
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
    const [pos, setPos] = React.useState({ top: 0, left: 0 });

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
        if (open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            setPos({ top: r.bottom + 4, left: r.left });
        }
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
                    className="fixed z-[9999] rounded-xl shadow-2xl border border-blue-400/30 overflow-hidden"
                    style={{ top: pos.top, left: pos.left, minWidth: 220, maxWidth: 320, backgroundColor: '#0f172a' }}
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
                    <div className="max-h-52 overflow-auto">
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

