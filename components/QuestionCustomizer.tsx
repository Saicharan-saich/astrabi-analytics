import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Plus, Calendar, Settings, ArrowUpDown, Filter as FilterIcon, X, Columns3 } from 'lucide-react';
import { Dataset, ColumnType } from '../types';
import { FilterItem } from './FilterItem';
import { DateFilterItem } from './DateFilterItem';
import { Tooltip } from './Tooltip';

interface QuestionCustomizerProps {
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
    questionLabel: string;
    allowedControls?: string[];
    // Column override props
    questionReq?: string[];               // Required roles for this question (e.g. ['revenue', 'product_name', 'order_date'])
    columnMapping?: Record<string, string>; // Auto-resolved role → column mapping
    semanticOverrides?: Record<string, string>; // Current user overrides
    onColumnOverrideChange?: (role: string, column: string) => void;
}

interface DimensionFilter {
    id: number;
    type: 'dimension';
    column: string;
    value: string | string[];
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

// ... imports

export const QuestionCustomizer: React.FC<QuestionCustomizerProps> = ({
    dataset,
    onRun,
    initialMetric = '',
    initialAggregation = 'SUM',
    initialDimension = '',
    initialTimeFilter = '',
    initialLimit = 0,
    initialSort = 'desc',
    asOfDate,
    onDateChange,
    anchorColumn,
    onAnchorColumnChange,
    questionLabel,
    allowedControls = ['metric', 'aggregation', 'dimension', 'time', 'sort', 'limit', 'filters'],
    questionReq,
    columnMapping,
    semanticOverrides: parentOverrides,
    onColumnOverrideChange
}) => {
    const [showColumnOverrides, setShowColumnOverrides] = useState(false);
    const [metric, setMetric] = useState<string>(initialMetric);
    const [aggregation, setAggregation] = useState<string>(initialAggregation);
    const [dimension, setDimension] = useState<string>(initialDimension);
    const [timeFilter, setTimeFilter] = useState(initialTimeFilter);
    const [sort, setSort] = useState<'desc' | 'asc' | 'oldest' | 'newest'>(initialSort as any || 'desc');
    const [limit, setLimit] = useState<number>(initialLimit);
    const [maWindow, setMaWindow] = useState<number>(7); // Moving average window size
    const [filters, setFilters] = useState<Filter[]>([]);
    const [nextFilterId, setNextFilterId] = useState(1);

    const ignoreNextRun = useRef(false);
    const [runCounter, setRunCounter] = useState(0); // Force fresh runs on every change
    const onRunRef = useRef(onRun);
    useEffect(() => { onRunRef.current = onRun; });

    // Initial Sync
    // Initial Sync
    useEffect(() => {
        let changed = false;
        if (initialMetric !== undefined && initialMetric !== metric) { setMetric(initialMetric); changed = true; }
        if (initialAggregation !== undefined && initialAggregation !== aggregation) { setAggregation(initialAggregation); changed = true; }
        if (initialDimension !== undefined && initialDimension !== dimension) { setDimension(initialDimension); changed = true; }
        if (initialTimeFilter !== undefined && initialTimeFilter !== timeFilter) { setTimeFilter(initialTimeFilter); changed = true; }
        if (initialLimit !== undefined && initialLimit !== limit) { setLimit(initialLimit); changed = true; }
        if (initialSort !== undefined && initialSort !== sort) { setSort(initialSort); changed = true; }

        if (changed) {
            ignoreNextRun.current = true;
        }
    }, [initialMetric, initialDimension, initialTimeFilter, initialLimit, initialSort, initialAggregation]);

    // Metadata extraction
    // Include IDs in metrics list to allow COUNT(DISTINCT id)
    const metrics = dataset.columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name);
    const dims = dataset.columns.filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID).map(c => c.name);
    const dateColumns = dataset.columns.filter(c => c.type === ColumnType.DATE).map(c => c.name);

    // Cache logic (duplicated from Builder for safety)
    const columnValuesCache = useRef<Record<string, string[]>>({});
    useEffect(() => { columnValuesCache.current = {}; }, [dataset]);

    const getColumnValues = (columnName: string): string[] => {
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
    };

    const getDateValues = (columnName: string, grain: string, selectedParentValues: string[] = []): string[] => {
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
                const pad = (n: number) => n.toString().padStart(2, '0');

                if (selectedParentValues.length > 0) {
                    const firstParent = selectedParentValues[0];
                    let parentMatches = false;
                    // Simplified hierarchy check
                    if (firstParent.match(/^\d{4}$/)) parentMatches = selectedParentValues.includes(`${year}`);
                    else if (firstParent.match(/^\d{4}-Q\d$/)) { const q = Math.ceil(month / 3); parentMatches = selectedParentValues.includes(`${year}-Q${q}`); }
                    else if (firstParent.match(/^\d{4}-\d{2}$/)) parentMatches = selectedParentValues.includes(`${year}-${pad(month)}`);
                    else if (firstParent.match(/^\d{4}-W\d{2}$/)) {
                        // Week logic omitted for brevity in this cache check, assuming standard hierarchy
                        // Re-implement if critical
                        parentMatches = true; // Placeholder
                    }
                    if (!parentMatches) return;
                }

                let formatted = '';
                if (grain === 'year') formatted = `${year}`;
                else if (grain === 'quarter') { const q = Math.ceil(month / 3); formatted = `${year}-Q${q}`; }
                else if (grain === 'month') formatted = `${year}-${pad(month)}`;
                else if (grain === 'week') {
                    // Week calc
                    const target = new Date(d.valueOf());
                    const dayNr = (d.getDay() + 6) % 7;
                    target.setDate(target.getDate() - dayNr + 3);
                    const firstThursday = target.valueOf();
                    target.setMonth(0, 1);
                    if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
                    const week = 1 + Math.ceil((firstThursday - target.valueOf()) / 604800000);
                    formatted = `${year}-W${pad(week)}`;
                }
                else if (grain === 'day') formatted = `${year}-${pad(month)}-${pad(day)}`;

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
                if (values.length > 0) dimensionFilters[f.column] = values;
            } else if (f.type === 'measure' && f.column) {
                measureFilters.push({ column: f.column, operator: f.operator, value: f.value });
            } else if (f.type === 'date' && f.column) {
                if (f.values && f.values.length > 0) dateFilters.push({ column: f.column, timeGrain: f.timeGrain, values: f.values });
            }
        });


        console.log('[QC handleRun] FIRING:', { metric, aggregation, dimension, timeFilter, sort, limit, maWindow });
        onRunRef.current({
            metric,
            aggregation,
            dimension,
            timeFilter,
            filters: dimensionFilters,
            measureFilters,
            dateFilters,
            sort,
            limit,
            maWindow
        });
    };

    useEffect(() => {
        if (metric) {
            if (ignoreNextRun.current) {
                console.log('[QC useEffect] SKIPPED (ignoreNextRun)', { metric, dimension, timeFilter });
                ignoreNextRun.current = false;
                return;
            }
            console.log('[QC useEffect] SCHEDULING run in 400ms', { metric, dimension, timeFilter, sort, limit });
            const timer = setTimeout(() => handleRun(), 400);
            return () => clearTimeout(timer);
        }
    }, [metric, aggregation, dimension, timeFilter, filters, sort, limit, maWindow, runCounter]);

    // Filter Handlers
    const addFilter = (type: 'dimension' | 'measure' | 'date', column?: string, grain?: string) => {
        if (type === 'date') setFilters([...filters, { id: nextFilterId, type: 'date', column: column || dateColumns[0] || '', timeGrain: (grain as any) || 'year', values: [] }]);
        else if (type === 'dimension') setFilters([...filters, { id: nextFilterId, type: 'dimension', column: dims.length ? dims[0] : '', value: [] }]);
        else setFilters([...filters, { id: nextFilterId, type: 'measure', column: metric || (metrics.length ? metrics[0] : ''), operator: '>', value: 0 }]);
        setNextFilterId(nextFilterId + 1);
    };

    const removeFilter = (id: number) => setFilters(filters.filter(f => f.id !== id));
    const updateFilter = (id: number, field: string, value: any) => {
        setFilters(prev => prev.map(f => {
            if (f.id === id) {
                if (field === 'column' && f.type === 'dimension') return { ...f, [field]: value, value: [] };
                return { ...f, [field]: value };
            }
            return f;
        }));
    };

    return (
        <div className="w-full bg-white border-b border-slate-200 shadow-sm relative z-50">
            <div className="max-w-7xl mx-auto px-4 py-2">
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                        <h2 className="text-base font-bold text-slate-800">{questionLabel}</h2>
                        <div className="flex items-center gap-2">
                            {/* Column Override Toggle */}
                            {questionReq && questionReq.length > 0 && onColumnOverrideChange && (
                                <Tooltip text="Override the auto-detected columns used by this question" position="bottom">
                                    <button
                                        onClick={() => setShowColumnOverrides(!showColumnOverrides)}
                                        className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg border transition-all ${showColumnOverrides
                                            ? 'bg-amber-50 text-amber-700 border-amber-300 shadow-sm'
                                            : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
                                            }`}
                                    >
                                        <Columns3 className="w-3.5 h-3.5" />
                                        Columns
                                        {parentOverrides && Object.keys(parentOverrides).length > 0 && (
                                            <span className="bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full ml-1">
                                                {Object.keys(parentOverrides).length}
                                            </span>
                                        )}
                                    </button>
                                </Tooltip>
                            )}
                            {/* Date Column Picker */}
                            {dataset.timeContext?.dateColumnMaxDates && Object.keys(dataset.timeContext.dateColumnMaxDates).length > 1 && (
                                <Tooltip text="Choose which date column drives the time anchor." position="bottom">
                                    <select
                                        value={anchorColumn || dataset.timeContext?.anchorDateColumn || ''}
                                        onChange={(e) => onAnchorColumnChange?.(e.target.value)}
                                        className="text-xs font-medium text-indigo-600 bg-indigo-50 border border-indigo-200 rounded-md px-2 py-1 cursor-pointer focus:outline-none focus:ring-1 focus:ring-indigo-300"
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
                                <div className="flex items-center gap-1.5 bg-slate-50 px-2 py-1 rounded-lg border border-slate-200">
                                    <Calendar className="w-3.5 h-3.5 text-slate-500" />
                                    <span className="text-[10px] text-slate-500 font-bold uppercase">As of</span>
                                    <input
                                        type="date"
                                        value={asOfDate}
                                        onChange={(e) => onDateChange(e.target.value)}
                                        className="text-xs font-semibold text-slate-700 bg-transparent border-none focus:outline-none cursor-pointer p-0"
                                    />
                                </div>
                            </Tooltip>
                        </div>
                    </div>

                    {/* Column Override Panel */}
                    {showColumnOverrides && questionReq && columnMapping && onColumnOverrideChange && (
                        <div className="bg-amber-50/50 border border-amber-200 rounded-lg p-2.5 animate-in slide-in-from-top-1 duration-200">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] uppercase font-bold text-amber-600 tracking-wider flex items-center gap-1">
                                    <Columns3 className="w-3 h-3" /> Column Mapping Override
                                </span>
                                <span className="text-[10px] text-amber-500">Auto-detected → Override</span>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                {questionReq.filter(role => role !== 'order_date').map(role => {
                                    const autoCol = columnMapping[role] || '—';
                                    const overrideVal = parentOverrides?.[role] || '';
                                    const isOverridden = overrideVal && overrideVal !== autoCol;

                                    // Determine compatible columns based on role type
                                    const isMetricRole = ['revenue', 'quantity', 'cost', 'discount', 'profit', 'price', 'sales'].includes(role);
                                    const isIdRole = ['order_id', 'customer_id'].includes(role);
                                    const options = isMetricRole
                                        ? dataset.columns.filter(c => c.type === ColumnType.METRIC).map(c => c.name)
                                        : isIdRole
                                            ? dataset.columns.filter(c => c.type === ColumnType.ID || c.type === ColumnType.DIMENSION).map(c => c.name)
                                            : dataset.columns.filter(c => c.type === ColumnType.DIMENSION || c.type === ColumnType.ID).map(c => c.name);

                                    const roleLabel = role.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

                                    return (
                                        <div key={role} className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 border transition-all ${isOverridden
                                            ? 'bg-amber-100 border-amber-300'
                                            : 'bg-white border-slate-200'
                                            }`}>
                                            <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider whitespace-nowrap">{roleLabel}</span>
                                            <div className="relative">
                                                <select
                                                    value={overrideVal || autoCol}
                                                    onChange={(e) => onColumnOverrideChange(role, e.target.value)}
                                                    className={`appearance-none text-xs font-semibold rounded-md px-2 py-1 pr-6 outline-none cursor-pointer transition-colors ${isOverridden
                                                        ? 'bg-amber-200/50 text-amber-800 border border-amber-300'
                                                        : 'bg-slate-50 text-slate-700 border border-slate-200 hover:border-slate-300'
                                                        }`}
                                                >
                                                    <option value={autoCol}>{autoCol} (auto)</option>
                                                    {options.filter(o => o !== autoCol).map(o => (
                                                        <option key={o} value={o}>{o}</option>
                                                    ))}
                                                </select>
                                                <ChevronDown className="w-3 h-3 text-slate-400 absolute right-1.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                                            </div>
                                            {isOverridden && (
                                                <button
                                                    onClick={() => onColumnOverrideChange(role, autoCol)}
                                                    className="text-amber-500 hover:text-amber-700 transition-colors"
                                                    title="Reset to auto-detected column"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Controls Row */}
                    <div className="flex flex-wrap items-start gap-3 p-2 bg-slate-50 rounded-lg border border-slate-100">
                        {/* Metric */}
                        {allowedControls.includes('metric') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Metric</label>
                                <div className="relative">
                                    <select
                                        value={metric}
                                        onChange={e => setMetric(e.target.value)}
                                        className="appearance-none bg-white border border-slate-200 hover:border-indigo-300 text-indigo-900 text-sm font-semibold rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 outline-none min-w-[140px]"
                                    >
                                        {metrics.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
                                    </select>
                                    <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        )}

                        {/* Aggregation */}
                        {allowedControls.includes('aggregation') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Agg</label>
                                <div className="relative">
                                    <select
                                        value={aggregation}
                                        onChange={e => setAggregation(e.target.value)}
                                        className="appearance-none bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-sm font-medium rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-slate-100 outline-none w-[90px]"
                                    >
                                        <option value="SUM">Sum</option>
                                        <option value="AVG">Avg</option>
                                        <option value="MAX">Max</option>
                                        <option value="MIN">Min</option>
                                        <option value="COUNT">Count</option>
                                    </select>
                                    <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        )}

                        {/* Dimension */}
                        {allowedControls.includes('dimension') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Group By</label>
                                <div className="relative">
                                    <select
                                        value={dimension}
                                        onChange={e => setDimension(e.target.value)}
                                        className="appearance-none bg-white border border-slate-200 hover:border-emerald-300 text-emerald-900 text-sm font-semibold rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-emerald-100 focus:border-emerald-400 outline-none min-w-[140px]"
                                    >
                                        <optgroup label="Time">
                                            {['day', 'week', 'month', 'quarter', 'year'].map(t => <option key={t} value={t}>{t}</option>)}
                                        </optgroup>
                                        <optgroup label="Columns">
                                            {dims.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
                                        </optgroup>
                                    </select>
                                    <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        )}

                        {/* Time Filter */}
                        {allowedControls.includes('time') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Time Period</label>
                                <div className="flex items-center gap-2">
                                    <div className="relative">
                                        <select
                                            value={timeFilter.startsWith('last_') && !['last_7_days', 'last_30_days', 'last_90_days', 'last_year'].includes(timeFilter) ? 'custom' : (timeFilter || '')}
                                            onChange={e => {
                                                const val = e.target.value;
                                                if (val === 'custom') setTimeFilter('last_10_days');
                                                else setTimeFilter(val);
                                            }}
                                            className="appearance-none bg-white border border-slate-200 hover:border-orange-300 text-orange-900 text-sm font-semibold rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-orange-100 focus:border-orange-400 outline-none w-[150px]"
                                        >
                                            <option value="">Default</option>
                                            <option value="all_time">All Time</option>
                                            <option value="today">Today</option>
                                            <option value="yesterday">Yesterday</option>
                                            <option value="this_week">This Week</option>
                                            <option value="this_month">This Month</option>
                                            <option value="this_quarter">This Quarter</option>
                                            <option value="this_year">This Year</option>
                                            <option value="last_7_days">Last 7 Days</option>
                                            <option value="last_30_days">Last 30 Days</option>
                                            <option value="last_90_days">Last 90 Days</option>
                                            <option value="custom">
                                                {timeFilter.startsWith('last_') && !['last_7_days', 'last_30_days', 'last_90_days', 'last_year'].includes(timeFilter)
                                                    ? `Last ${timeFilter.split('_')[1]} ${(timeFilter.split('_')[2] || 'days').replace('cyears', 'Cal Years').replace('years', 'Years').replace('months', 'Months').replace('weeks', 'Weeks').replace('days', 'Days')}`
                                                    : 'Custom Last...'
                                                }
                                            </option>
                                        </select>
                                        <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                    {(timeFilter.startsWith('last_') && !['last_7_days', 'last_30_days', 'last_90_days', 'last_year'].includes(timeFilter)) && (
                                        <div className="flex items-center gap-1">
                                            <input
                                                type="number"
                                                min="1"
                                                value={timeFilter.split('_')[1]}
                                                onChange={e => {
                                                    const n = parseInt(e.target.value) || 1;
                                                    const unit = timeFilter.split('_')[2] || 'days';
                                                    setTimeFilter(`last_${n}_${unit}`);
                                                }}
                                                className="w-12 text-sm text-center text-slate-900 bg-white border border-slate-200 rounded-lg py-1.5 focus:ring-2 focus:ring-orange-100 outline-none"
                                            />
                                            <div className="relative">
                                                <select
                                                    value={(timeFilter.split('_')[2] || 'days').replace('cyears', 'years')}
                                                    onChange={e => {
                                                        const n = timeFilter.split('_')[1] || '7';
                                                        let unit = e.target.value;
                                                        // Default to calendar year mode when switching TO years
                                                        if (unit === 'years') unit = 'cyears';
                                                        // Unless user explicitly picked trailing before
                                                        if (unit === 'cyears' && (timeFilter.split('_')[2] || '') === 'years') unit = 'years';
                                                        setTimeFilter(`last_${n}_${unit}`);
                                                    }}
                                                    className="appearance-none bg-white border border-slate-200 text-slate-700 text-sm font-medium rounded-lg px-2 py-1.5 pr-6 outline-none"
                                                >
                                                    <option value="days">D</option>
                                                    <option value="weeks">W</option>
                                                    <option value="months">M</option>
                                                    <option value="years">Y</option>
                                                </select>
                                                <ChevronDown className="w-3 h-3 text-slate-400 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
                                            </div>
                                            {/* Calendar vs Trailing toggle — only visible when unit is years */}
                                            {(timeFilter.split('_')[2] === 'years' || timeFilter.split('_')[2] === 'cyears') && (
                                                <div className="flex bg-orange-50 p-0.5 rounded-lg border border-orange-200 ml-1">
                                                    <button
                                                        onClick={() => {
                                                            const n = timeFilter.split('_')[1] || '1';
                                                            setTimeFilter(`last_${n}_years`);
                                                        }}
                                                        className={`px-2 py-0.5 text-[10px] font-bold rounded-md transition-all ${timeFilter.split('_')[2] === 'years'
                                                            ? 'bg-white text-orange-700 shadow-sm'
                                                            : 'text-orange-400 hover:text-orange-600'
                                                            }`}
                                                        title="Rolling window: Last N×365 days from the As-Of date"
                                                    >Trailing</button>
                                                    <button
                                                        onClick={() => {
                                                            const n = timeFilter.split('_')[1] || '1';
                                                            setTimeFilter(`last_${n}_cyears`);
                                                        }}
                                                        className={`px-2 py-0.5 text-[10px] font-bold rounded-md transition-all ${timeFilter.split('_')[2] === 'cyears'
                                                            ? 'bg-white text-orange-700 shadow-sm'
                                                            : 'text-orange-400 hover:text-orange-600'
                                                            }`}
                                                        title="Full calendar years: e.g. Last 1 = previous full year"
                                                    >Calendar</button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* View Toggle (Total vs Trend) — separate column for alignment */}
                        {allowedControls.includes('time') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">View</label>
                                <div className="flex items-center gap-2">
                                    <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                                        <button
                                            onClick={() => {
                                                setDimension('');
                                                setRunCounter(prev => prev + 1);
                                            }}
                                            className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${!dimension || !['day', 'week', 'month', 'year'].includes(dimension)
                                                ? 'bg-white text-slate-700 shadow-sm'
                                                : 'text-slate-500 hover:text-slate-700'
                                                }`}
                                        >
                                            Total
                                        </button>
                                        <button
                                            onClick={() => {
                                                let defaultGrain = 'day';
                                                if (timeFilter.includes('year') || timeFilter === 'all_time') {
                                                    defaultGrain = 'month';
                                                } else if (timeFilter.includes('quarter') || timeFilter.includes('90_days')) {
                                                    defaultGrain = 'week';
                                                }
                                                if (!dimension) setSort('oldest');
                                                setDimension(defaultGrain);
                                                setRunCounter(prev => prev + 1);
                                            }}
                                            className={`px-3 py-1 text-xs font-semibold rounded-md transition-all ${['day', 'week', 'month', 'year'].includes(dimension)
                                                ? 'bg-white text-emerald-600 shadow-sm'
                                                : 'text-slate-500 hover:text-slate-700'
                                                }`}
                                        >
                                            Trend
                                        </button>
                                    </div>

                                    {/* Time Grain Selector (Visible only in Trend Mode) */}
                                    {['day', 'week', 'month', 'year'].includes(dimension) && (
                                        <div className="relative">
                                            <select
                                                value={dimension}
                                                onChange={(e) => {
                                                    setDimension(e.target.value);
                                                    setRunCounter(prev => prev + 1);
                                                }}
                                                className="appearance-none bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-bold rounded-lg pl-3 pr-6 py-1.5 outline-none hover:border-emerald-300 focus:ring-1 focus:ring-emerald-200"
                                            >
                                                <option value="day">Day</option>
                                                <option value="week">Week</option>
                                                <option value="month">Month</option>
                                                <option value="quarter">Quarter</option>
                                                <option value="year">Year</option>
                                            </select>
                                            <ChevronDown className="w-3 h-3 text-emerald-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Moving Average Window Selector — visible only for MA questions */}
                        {questionLabel.toLowerCase().includes('moving average') && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Window</label>
                                <div className="relative">
                                    <select
                                        value={[3, 5, 7, 14, 30].includes(maWindow) ? maWindow : 'custom'}
                                        onChange={e => {
                                            const val = e.target.value;
                                            if (val === 'custom') setMaWindow(10);
                                            else setMaWindow(Number(val));
                                        }}
                                        className="appearance-none bg-white border border-slate-200 hover:border-violet-300 text-violet-900 text-sm font-semibold rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-violet-100 focus:border-violet-400 outline-none w-[110px]"
                                    >
                                        <option value={3}>3-Day</option>
                                        <option value={5}>5-Day</option>
                                        <option value={7}>7-Day</option>
                                        <option value={14}>14-Day</option>
                                        <option value={30}>30-Day</option>
                                        <option value="custom">Custom</option>
                                    </select>
                                    <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                                {(![3, 5, 7, 14, 30].includes(maWindow)) && (
                                    <input
                                        type="number"
                                        min="2"
                                        max="365"
                                        value={maWindow}
                                        onChange={e => setMaWindow(Math.max(2, parseInt(e.target.value) || 7))}
                                        className="w-16 text-sm text-center text-slate-900 bg-white border border-slate-200 rounded-lg py-1.5 focus:ring-2 focus:ring-violet-100 outline-none mt-1"
                                    />
                                )}
                            </div>
                        )}

                        {/* Sort */}
                        {(allowedControls.includes('sort') || ((dimension && dimension !== ''))) && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Sort</label>
                                <div className="relative">
                                    <select
                                        value={sort}
                                        onChange={e => setSort(e.target.value as any)}
                                        className="appearance-none bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-sm font-medium rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-slate-100 outline-none w-[130px]"
                                    >
                                        <option value="desc">High to Low</option>
                                        <option value="asc">Low to High</option>
                                        <option value="oldest">Date (Oldest)</option>
                                        <option value="newest">Date (Newest)</option>
                                    </select>
                                    <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        )}

                        {/* Limit */}
                        {(allowedControls.includes('limit') || ((dimension && dimension !== ''))) && (
                            <div className="flex flex-col gap-1">
                                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider">Limit</label>
                                <div className="flex items-center gap-1">
                                    <div className="relative">
                                        <select
                                            value={limit > 0 && ![5, 10, 20, 50].includes(limit) ? 'custom' : (limit <= 0 ? -1 : limit)}
                                            onChange={e => {
                                                const val = e.target.value;
                                                if (val === 'custom') setLimit(15);
                                                else setLimit(Number(val));
                                            }}
                                            className="appearance-none bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-sm font-medium rounded-lg px-3 py-1.5 pr-8 transition-colors focus:ring-2 focus:ring-slate-100 outline-none w-[100px]"
                                        >
                                            <option value={-1}>All</option>
                                            <option value={5}>Top 5</option>
                                            <option value={10}>Top 10</option>
                                            <option value={20}>Top 20</option>
                                            <option value={50}>Top 50</option>
                                            <option value="custom">Custom</option>
                                        </select>
                                        <ChevronDown className="w-3 h-3 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                    </div>
                                    {(limit > 0 && ![5, 10, 20, 50].includes(limit)) && (
                                        <input
                                            type="number"
                                            min="1"
                                            value={limit}
                                            onChange={e => setLimit(parseInt(e.target.value) || 1)}
                                            className="w-16 text-sm text-center text-slate-900 bg-white border border-slate-200 rounded-lg py-1.5 focus:ring-2 focus:ring-slate-100 outline-none"
                                        />
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Filter Bar */}
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="flex items-center gap-2 mr-2">
                            <FilterIcon className="w-4 h-4 text-slate-400" />
                            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">Filters</span>
                        </div>

                        {filters.map(filter => {
                            if (filter.type === 'date') {
                                const priorGrain = getPriorGrain(filter.timeGrain);
                                const parentFilter = priorGrain ? filters.find(p => p.type === 'date' && p.column === filter.column && p.timeGrain === priorGrain) as DateFilter : undefined;
                                return <DateFilterItem key={filter.id} id={filter.id} filter={filter} dateColumns={dateColumns} getDateValues={getDateValues} onUpdate={updateFilter} onRemove={removeFilter} onAddFilter={addFilter} selectedParentValues={parentFilter?.values} />;
                            }
                            return <FilterItem key={filter.id} id={filter.id} filter={filter} dims={dims} metrics={metrics} getColumnValues={getColumnValues} onUpdate={updateFilter} onRemove={removeFilter} />;
                        })}

                        {/* Add Filter Dropdown */}
                        {allowedControls.includes('filters') && (
                            <div className="group relative ml-2">
                                <button className="flex items-center gap-1 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg border border-indigo-200 transition-colors">
                                    <Plus className="w-3 h-3" /> Add Filter
                                </button>
                                <div className="absolute top-full left-0 pt-1 w-48 hidden group-hover:block z-50">
                                    <div className="bg-white rounded-lg shadow-xl border border-slate-100 p-1">
                                        <button onClick={() => addFilter('dimension')} className="w-full text-left px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded">Dimension Filter</button>
                                        <button onClick={() => addFilter('measure')} className="w-full text-left px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded">Value Filter</button>
                                        {dateColumns.length > 0 && (
                                            <button onClick={() => addFilter('date')} className="w-full text-left px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded">Date Filter</button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
