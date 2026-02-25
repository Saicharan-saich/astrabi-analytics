import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Plus, Calendar, Settings, ArrowUpDown, Filter, X, TrendingUp, List, Hash } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { FilterItem } from './FilterItem';
import { DateFilterItem } from './DateFilterItem';
import { Tooltip } from './Tooltip';

interface QuestionBuilderProps {
    dataset: Dataset;
    onRun: (config: any) => void;
    initialMetric?: string;
    initialAggregation?: string;
    initialDimension?: string;
    initialTimeFilter?: string;
    initialLimit?: number;
    initialSort?: 'desc' | 'asc';
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
    timeGrain: 'year' | 'quarter' | 'month' | 'week' | 'day';
    values: string[];
}

type Filter = DimensionFilter | MeasureFilter | DateFilter;

const getNextGrain = (grain: string) => {
    switch (grain) {
        case 'year': return 'quarter';
        case 'quarter': return 'month';
        case 'month': return 'week';
        case 'week': return 'day';
        default: return null;
    }
};

const getPriorGrain = (grain: string) => {
    switch (grain) {
        case 'quarter': return 'year';
        case 'month': return 'quarter';
        case 'week': return 'month';
        case 'day': return 'week'; // Assuming week is parent of day
        default: return null;
    }
};

export const QuestionBuilder: React.FC<QuestionBuilderProps> = ({
    dataset,
    onRun,
    initialMetric = '',
    initialAggregation = 'SUM',
    initialDimension = '',
    initialTimeFilter = 'all_time',
    initialLimit = 0,
    initialSort = 'desc',
    asOfDate,
    onDateChange,
    anchorColumn,
    onAnchorColumnChange
}) => {
    const [metric, setMetric] = useState<string>(initialMetric);
    const [aggregation, setAggregation] = useState<string>(initialAggregation);
    const [dimension, setDimension] = useState<string>(initialDimension);
    const [timeFilter, setTimeFilter] = useState(initialTimeFilter);
    const [sort, setSort] = useState<'desc' | 'asc' | 'oldest' | 'newest'>(initialSort as any || 'desc');
    const [limit, setLimit] = useState<number>(initialLimit);

    const [filters, setFilters] = useState<Filter[]>([]);
    const [nextFilterId, setNextFilterId] = useState(1);

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
        if (initialDimension) setDimension(initialDimension);
        if (initialTimeFilter) setTimeFilter(initialTimeFilter);
        setLimit(initialLimit);
        if (initialSort) setSort(initialSort);

        // Prevent the auto-run effect from firing immediately after this sync
        // because the parent (Workbench) has already run the correct analysis.
        ignoreNextRun.current = true;
    }, [initialMetric, initialDimension, initialTimeFilter, initialLimit, initialSort]);

    // Extract columns
    const metrics = dataset.columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
    const dims = dataset.columns.filter(c => c.type === ColumnType.DIMENSION).map(c => c.name);
    const dateColumns = dataset.columns.filter(c => c.type === ColumnType.DATE).map(c => c.name);


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
                if (f.values && f.values.length > 0) {
                    dateFilters.push({ column: f.column, timeGrain: f.timeGrain, values: f.values });
                }
            }
        });

        const config = {
            metric,
            aggregation,
            dimension,
            timeFilter,
            filters: dimensionFilters,
            measureFilters,
            dateFilters,
            sort,
            limit
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
    }, [metric, aggregation, dimension, timeFilter, filters, sort, limit]);

    // AUTO-DRILL DOWN EFFECT
    useEffect(() => {
        filters.forEach(f => {
            if (f.type === 'date' && f.values && f.values.length === 1 && f.column) {
                const nextGrain = getNextGrain(f.timeGrain);
                if (nextGrain) {
                    // Check if ANY child (next grain or deeper) exists
                    // If we are at Year, and Month exists, we should NOT add Quarter.
                    const hierarchy = ['year', 'quarter', 'month', 'week', 'day'];
                    const nextIdx = hierarchy.indexOf(nextGrain);

                    if (nextIdx !== -1) {
                        const hasDescendant = filters.some(c =>
                            c.type === 'date' &&
                            c.column === f.column &&
                            hierarchy.indexOf(c.timeGrain) >= nextIdx // exists at next level or deeper
                        );

                        if (!hasDescendant) {
                            console.log('[QuestionBuilder] Auto-adding drilldown filter:', nextGrain);
                            addFilter('date', f.column, nextGrain);
                        }
                    }
                }
            }
        });
    }, [filters]);

    // Filter Handlers
    const addFilter = (type: 'dimension' | 'measure' | 'date', column?: string, grain?: string) => {
        if (type === 'date') {
            setFilters([...filters, {
                id: nextFilterId,
                type: 'date',
                column: column || dateColumns[0] || '',
                timeGrain: (grain as any) || 'year',
                values: []
            }]);
        } else if (type === 'dimension') {
            setFilters([...filters, {
                id: nextFilterId,
                type: 'dimension',
                column: '',
                value: ''
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

            // Recursive Reset Logic:
            if (field === 'values') {
                const parent = updatedFilters.find(f => f.id === id);
                if (parent && parent.type === 'date' && parent.column) {
                    // AUTO-SWITCH TO TREND: If user selects multiple dates and we are in Total mode, switch to Trend.
                    if (value && value.length > 1 && !dimension) {
                        const grain = (parent.timeGrain as string) || 'day';
                        console.log('[QuestionBuilder] Auto-switching to Trend:', grain);
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
    };

    return (
        <div className="max-w-7xl mx-auto px-4 py-0 bg-slate-50 border-b border-slate-200">
            {/* Header / Context */}
            <div className="flex justify-end mb-1">
                <div className="flex items-center gap-2 bg-white px-2 py-1 bg-opacity-80 rounded-b-lg shadow-sm border border-t-0 border-slate-200">
                    {/* Date Column Picker */}
                    {dataset.timeContext?.dateColumnMaxDates && Object.keys(dataset.timeContext.dateColumnMaxDates).length > 1 && (
                        <Tooltip text="Choose which date column drives the time anchor. Different columns may have different date ranges." position="bottom">
                            <select
                                value={anchorColumn || dataset.timeContext?.anchorDateColumn || ''}
                                onChange={(e) => onAnchorColumnChange?.(e.target.value)}
                                className="text-xs font-medium text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-md px-1.5 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-300"
                            >
                                {Object.entries(dataset.timeContext.dateColumnMaxDates).map(([col, maxDate]) => (
                                    <option key={col} value={col}>
                                        {col.replace(/_/g, ' ')} (max: {maxDate})
                                    </option>
                                ))}
                            </select>
                        </Tooltip>
                    )}
                    <Tooltip text="As of date — defines what 'today' means for time queries. Defaults to MAX date in your dataset." position="bottom">
                        <span className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <span className="text-xs text-slate-500 font-medium">As of:</span>
                            <input
                                type="date"
                                value={asOfDate}
                                onChange={(e) => onDateChange(e.target.value)}
                                className="text-xs font-bold text-slate-700 bg-transparent border-none focus:ring-0 cursor-pointer p-0"
                            />
                        </span>
                    </Tooltip>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-base font-medium text-slate-700 leading-snug">
                <img src="/logo.jpg" alt="Astrabi" className="w-5 h-5 rounded mr-1 shadow-sm" />
                <span>Show me</span>

                {/* Metric Selector */}
                <Tooltip text="Choose the numeric measure to analyze (e.g. revenue, quantity, profit). This is the 'what' of your question." position="bottom">
                    <div className="relative group inline-block">
                        <select
                            value={metric}
                            onChange={e => setMetric(e.target.value)}
                            className="appearance-none bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold border-b-2 border-indigo-300 rounded px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-indigo-500"
                        >
                            {metrics.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
                        </select>
                        <ChevronDown className="w-4 h-4 text-indigo-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                </Tooltip>

                <span>(</span>
                <Tooltip text="How to aggregate the metric: Sum adds up values, Average calculates the mean, Count tallies rows, Unique Count counts distinct values." position="bottom">
                    <div className="relative group inline-block">
                        <select
                            value={aggregation}
                            onChange={e => setAggregation(e.target.value)}
                            className="appearance-none bg-transparent hover:bg-slate-100 text-slate-500 font-medium border-b border-slate-300 rounded px-1 py-0.5 pr-4 text-sm cursor-pointer focus:outline-none"
                        >
                            <option value="SUM">Sum</option>
                            <option value="AVG">Average</option>
                            <option value="MAX">Max</option>
                            <option value="MIN">Min</option>
                            <option value="COUNT">Count</option>
                            <option value="COUNT_DISTINCT">Unique Count</option>
                        </select>
                        <ChevronDown className="w-3 h-3 text-slate-400 absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                </Tooltip>
                <span>)</span>

                <span>by</span>

                {/* Total / Trend Shortcut */}
                <Tooltip text="Total shows a single aggregate number. Trend shows data over time (day/week/month/quarter/year)." position="bottom">
                    <div className="flex bg-slate-100 rounded-lg p-0.5 border border-slate-200 mx-1">
                        <button
                            onClick={() => setDimension('')}
                            title="View Total (Scalar)"
                            className={`px-3 py-1 text-sm font-bold rounded-md transition-colors ${!dimension ? 'bg-indigo-50 text-indigo-700 border border-indigo-200 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'}`}
                        >
                            Total
                        </button>
                        <button
                            onClick={() => {
                                if (!['day', 'week', 'month', 'quarter', 'year'].includes(dimension)) {
                                    setDimension('day');
                                }
                                setSort('oldest');
                            }}
                            title="View Trend (Time Series)"
                            className={`flex items-center gap-1 px-3 py-1 text-sm font-bold rounded-md transition-colors ${['day', 'week', 'month', 'quarter', 'year'].includes(dimension) ? 'bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-sm' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-200'}`}
                        >
                            <TrendingUp className="w-3.5 h-3.5" />
                            Trend
                        </button>
                    </div>
                </Tooltip>

                {/* Dimension Selector */}
                <Tooltip text="How to group or break down the metric. Choose a time grain (day/month/year) for trends, or a column (product, region) for comparisons." position="bottom">
                    <div className="relative group inline-block">
                        <select
                            value={dimension}
                            onChange={e => {
                                const newDim = e.target.value;
                                setDimension(newDim);
                                if (['day', 'week', 'month', 'quarter', 'year'].includes(newDim)) {
                                    setSort('oldest');
                                } else {
                                    setSort('desc');
                                }
                            }}
                            className={`appearance-none font-bold border-b-2 rounded px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 ${!dimension
                                ? 'bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-300 focus:ring-indigo-500'
                                : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border-emerald-300 focus:ring-emerald-500'
                                }`}
                        >
                            <option value="">(Total)</option>
                            <optgroup label="Time">
                                {['day', 'week', 'month', 'quarter', 'year'].map(t => <option key={t} value={t}>{t}</option>)}
                            </optgroup>
                            <optgroup label="Columns">
                                {dims.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
                            </optgroup>
                        </select>
                        <ChevronDown className={`w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none ${!dimension ? 'text-indigo-500' : 'text-emerald-500'}`} />
                    </div>
                </Tooltip>

                <span>where</span>

                {/* Time Filter */}
                <div className="flex items-center gap-2">
                    <Tooltip text="Filter data by time range relative to the AS OF date. 'Time is Anything' includes all data. 'Last...' lets you pick a custom window." position="bottom">
                        <div className="relative group inline-block">
                            <select
                                value={timeFilter.startsWith('last_') && !['last_30_days', 'last_90_days', 'last_year'].includes(timeFilter) ? 'custom' : timeFilter}
                                onChange={e => {
                                    const val = e.target.value;
                                    if (val === 'custom') setTimeFilter('last_7_days');
                                    else setTimeFilter(val);
                                }}
                                className="appearance-none bg-orange-50 hover:bg-orange-100 text-orange-700 font-bold border-b-2 border-orange-300 rounded px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-orange-500"
                            >
                                <option value="all_time">Time is Anything</option>
                                <option value="last_30_days">Last 30 Days</option>
                                <option value="last_90_days">Last 90 Days</option>
                                <option value="this_year">This Year</option>
                                <option value="custom">Last...</option>
                            </select>
                            <ChevronDown className="w-4 h-4 text-orange-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>
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
                                className="w-16 bg-white border-b-2 border-orange-300 rounded px-2 py-1 text-center font-bold text-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-500"
                            />
                            <div className="relative inline-block">
                                <select
                                    value={timeFilter.split('_')[2] || 'days'}
                                    onChange={e => {
                                        const n = timeFilter.split('_')[1] || '7';
                                        const unit = e.target.value;
                                        setTimeFilter(`last_${n}_${unit}`);
                                    }}
                                    className="appearance-none bg-white border-b-2 border-orange-300 rounded px-2 py-1 font-bold text-orange-700 focus:outline-none focus:ring-2 focus:ring-orange-500"
                                >
                                    <option value="days">Days</option>
                                    <option value="weeks">Weeks</option>
                                    <option value="months">Months</option>
                                    <option value="years">Years</option>
                                </select>
                                <ChevronDown className="w-3 h-3 text-orange-500 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                        </div>
                    )}
                </div>

                <span>and</span>

                {/* Limit Input */}
                <Tooltip text="Limit how many results to show. 'Show All' returns every row. 'Top N' keeps only the highest or lowest values." position="bottom">
                    <div className="flex items-center gap-1">
                        <div className="relative inline-block">
                            <select
                                value={limit > 0 && ![5, 10, 20, 50].includes(limit) ? 'custom' : (limit <= 0 ? -1 : limit)}
                                onChange={e => {
                                    const val = e.target.value;
                                    if (val === 'custom') setLimit(15);
                                    else setLimit(Number(val));
                                }}
                                className="appearance-none bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold border-b-2 border-slate-300 rounded px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-500"
                            >
                                <option value={-1}>Show All</option>
                                <option value={5}>Top 5</option>
                                <option value={10}>Top 10</option>
                                <option value={20}>Top 20</option>
                                <option value={50}>Top 50</option>
                                <option value="custom">Custom...</option>
                            </select>
                            <ChevronDown className="w-4 h-4 text-slate-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                        </div>

                        {/* Custom Top N Input */}
                        {(limit > 0 && ![5, 10, 20, 50].includes(limit)) && (
                            <input
                                type="number"
                                min="1"
                                value={limit}
                                onChange={e => setLimit(parseInt(e.target.value) || 1)}
                                className="w-16 bg-white border-b-2 border-slate-300 rounded px-2 py-1 text-center font-bold text-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500"
                            />
                        )}
                    </div>
                </Tooltip>

                <span>sorted</span>

                {/* Sort Selector */}
                <Tooltip text="Control how results are ordered. For trends, use Oldest/Newest. For rankings, use High to Low or Low to High." position="bottom">
                    <div className="relative group inline-block">
                        <select
                            value={sort}
                            onChange={e => setSort(e.target.value as 'asc' | 'desc')}
                            className="appearance-none bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold border-b-2 border-slate-300 rounded px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-slate-500"
                        >
                            <option value="desc">High to Low (Value)</option>
                            <option value="asc">Low to High (Value)</option>
                            <option value="oldest">Oldest First</option>
                            <option value="newest">Newest First</option>
                        </select>
                        <ChevronDown className="w-4 h-4 text-slate-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                </Tooltip>

                {/* Iterate Filters */}
                {filters.map(filter => {
                    if (filter.type === 'date') {
                        // FIND PARENT VALUES
                        const priorGrain = getPriorGrain(filter.timeGrain);
                        const parentFilter = priorGrain ? filters.find(p =>
                            p.type === 'date' &&
                            p.column === filter.column &&
                            p.timeGrain === priorGrain
                        ) as DateFilter : undefined;

                        const selectedParentValues = parentFilter?.values;

                        return (
                            <DateFilterItem
                                key={filter.id}
                                id={filter.id}
                                filter={filter}
                                dateColumns={dateColumns}
                                getDateValues={getDateValues}
                                onUpdate={updateFilter}
                                onRemove={removeFilter}
                                onAddFilter={addFilter}
                                selectedParentValues={selectedParentValues}
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

                {/* Add Filter Buttons */}
                <div className="flex items-center gap-2">
                    <Tooltip text="Add a dimension filter to narrow results by category, region, or other text/ID columns." position="top">
                        <button
                            onClick={() => addFilter('dimension')}
                            className="text-purple-600 hover:text-purple-700 text-sm font-medium border border-dashed border-purple-300 hover:border-purple-400 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Filter Check
                        </button>
                    </Tooltip>
                    <Tooltip text="Add a value filter to include only rows where a metric meets a condition (e.g. revenue > 1000)." position="top">
                        <button
                            onClick={() => addFilter('measure')}
                            className="text-blue-600 hover:text-blue-700 text-sm font-medium border border-dashed border-blue-300 hover:border-blue-400 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Value Filter
                        </button>
                    </Tooltip>

                    {dateColumns.length > 0 && (
                        <Tooltip text="Add a date-based drill filter to narrow results by year, quarter, month, or specific date range." position="top">
                            <button
                                onClick={() => addFilter('date')}
                                className="text-teal-600 hover:text-teal-700 text-sm font-medium border border-dashed border-teal-300 hover:border-teal-400 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1"
                            >
                                <Calendar className="w-3.5 h-3.5" />
                                Date Filter
                            </button>
                        </Tooltip>
                    )}

                    <Tooltip text="Add an extra metric to compare alongside the primary one." position="top">
                        <button
                            onClick={() => addFilter('measure')}
                            className="text-blue-600 hover:text-blue-700 text-sm font-medium border border-dashed border-blue-300 hover:border-blue-400 rounded-lg px-3 py-1.5 transition-colors flex items-center gap-1"
                        >
                            <Plus className="w-3.5 h-3.5" />
                            Measure
                        </button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
};
