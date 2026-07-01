import React, { useState, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { X, ChevronDown, Calendar, ArrowRight, Check } from 'lucide-react';

interface DateFilterItemProps {
    id: number;
    filter: any;
    dateColumns: string[];
    getDateValues: (col: string, grain: string, selectedParentValues?: string[]) => string[];
    onUpdate: (id: number, field: string, value: any) => void;
    onRemove: (id: number) => void;
}

/**
 * Unified date filter component with two modes:
 *   1) Hierarchy — Year → Quarter → Month → Day drill-down in one row (multi-select)
 *   2) Range    — From / To calendar pickers
 */
export const DateFilterItem: React.FC<DateFilterItemProps> = ({
    id, filter, dateColumns, getDateValues, onUpdate, onRemove
}) => {
    const mode: 'hierarchy' | 'range' = filter.mode || 'hierarchy';

    // ── Hierarchy mode: arrays for multi-select ────────────────
    const selectedYears: string[] = Array.isArray(filter.year) ? filter.year : (filter.year ? [filter.year] : []);
    const selectedQuarters: string[] = Array.isArray(filter.quarter) ? filter.quarter : (filter.quarter ? [filter.quarter] : []);
    const selectedMonths: string[] = Array.isArray(filter.month) ? filter.month : (filter.month ? [filter.month] : []);
    const selectedDays: string[] = Array.isArray(filter.day) ? filter.day : (filter.day ? [filter.day] : []);

    // ── Range mode helpers ──────────────────────────────────────
    const rangeStart = filter.rangeStart || '';
    const rangeEnd = filter.rangeEnd || '';

    // Get distinct values at each grain (filtered by parent selection)
    const years = useMemo(() => filter.column ? getDateValues(filter.column, 'year') : [], [filter.column]);
    const quarters = useMemo(() => {
        if (!filter.column) return [];
        // If year selected, filter by year; otherwise show ALL quarters
        return selectedYears.length > 0
            ? getDateValues(filter.column, 'quarter', selectedYears)
            : getDateValues(filter.column, 'quarter');
    }, [filter.column, selectedYears.join(',')]);
    const months = useMemo(() => {
        if (!filter.column) return [];
        if (selectedQuarters.length > 0) return getDateValues(filter.column, 'month', selectedQuarters);
        if (selectedYears.length > 0) return getDateValues(filter.column, 'month', selectedYears);
        return getDateValues(filter.column, 'month');
    }, [filter.column, selectedYears.join(','), selectedQuarters.join(',')]);
    const days = useMemo(() => {
        if (!filter.column) return [];
        if (selectedMonths.length > 0) return getDateValues(filter.column, 'day', selectedMonths);
        if (selectedQuarters.length > 0) return getDateValues(filter.column, 'day', selectedQuarters);
        if (selectedYears.length > 0) return getDateValues(filter.column, 'day', selectedYears);
        return [];
    }, [filter.column, selectedYears.join(','), selectedQuarters.join(','), selectedMonths.join(',')]);

    // Toggle mode
    const toggleMode = () => {
        const newMode = mode === 'hierarchy' ? 'range' : 'hierarchy';
        onUpdate(id, 'mode', newMode);
        onUpdate(id, 'year', []);
        onUpdate(id, 'quarter', []);
        onUpdate(id, 'month', []);
        onUpdate(id, 'day', []);
        onUpdate(id, 'rangeStart', '');
        onUpdate(id, 'rangeEnd', '');
        onUpdate(id, 'values', []);
    };

    // Update hierarchy: toggle a value in/out of the array and rebuild downstream
    const toggleHierarchy = (grain: string, val: string) => {
        const currentList =
            grain === 'year' ? [...selectedYears] :
                grain === 'quarter' ? [...selectedQuarters] :
                    grain === 'month' ? [...selectedMonths] :
                        [...selectedDays];

        const idx = currentList.indexOf(val);
        if (idx >= 0) currentList.splice(idx, 1);
        else currentList.push(val);

        onUpdate(id, grain, currentList);

        // Clear child levels when a parent changes
        if (grain === 'year') { onUpdate(id, 'quarter', []); onUpdate(id, 'month', []); onUpdate(id, 'day', []); }
        if (grain === 'quarter') { onUpdate(id, 'month', []); onUpdate(id, 'day', []); }
        if (grain === 'month') { onUpdate(id, 'day', []); }

        // Build the finest-grained value array for the engine
        const updated: Record<string, string[]> = {
            year: selectedYears, quarter: selectedQuarters,
            month: selectedMonths, day: selectedDays,
            [grain]: currentList,
        };
        if (grain === 'year') { updated.quarter = []; updated.month = []; updated.day = []; }
        if (grain === 'quarter') { updated.month = []; updated.day = []; }
        if (grain === 'month') { updated.day = []; }

        // Pick the finest non-empty level
        let finest: string[] = [];
        let finestGrain = 'year';
        if (updated.day.length > 0) { finest = updated.day; finestGrain = 'day'; }
        else if (updated.month.length > 0) { finest = updated.month; finestGrain = 'month'; }
        else if (updated.quarter.length > 0) { finest = updated.quarter; finestGrain = 'quarter'; }
        else if (updated.year.length > 0) { finest = updated.year; finestGrain = 'year'; }

        onUpdate(id, 'timeGrain', finestGrain);
        onUpdate(id, 'values', finest);
    };

    // Clear all selections at a grain
    const clearGrain = (grain: string) => {
        onUpdate(id, grain, []);
        if (grain === 'year') { onUpdate(id, 'quarter', []); onUpdate(id, 'month', []); onUpdate(id, 'day', []); }
        if (grain === 'quarter') { onUpdate(id, 'month', []); onUpdate(id, 'day', []); }
        if (grain === 'month') { onUpdate(id, 'day', []); }
        // Recalc finest
        const updated: Record<string, string[]> = {
            year: selectedYears, quarter: selectedQuarters,
            month: selectedMonths, day: selectedDays, [grain]: [],
        };
        if (grain === 'year') { updated.quarter = []; updated.month = []; updated.day = []; }
        if (grain === 'quarter') { updated.month = []; updated.day = []; }
        if (grain === 'month') { updated.day = []; }
        let finest: string[] = [];
        let finestGrain = 'year';
        if (updated.day.length > 0) { finest = updated.day; finestGrain = 'day'; }
        else if (updated.month.length > 0) { finest = updated.month; finestGrain = 'month'; }
        else if (updated.quarter.length > 0) { finest = updated.quarter; finestGrain = 'quarter'; }
        else if (updated.year.length > 0) { finest = updated.year; finestGrain = 'year'; }
        onUpdate(id, 'timeGrain', finestGrain);
        onUpdate(id, 'values', finest);
    };

    // Pretty label for grain values
    const shortLabel = (val: string, grain: string) => {
        if (grain === 'quarter') return val.split('-')[1] || val;
        if (grain === 'month') {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            const parts = val.split('-');
            const m = parseInt(parts[1] || '0', 10);
            return m >= 1 && m <= 12 ? monthNames[m - 1] : val;
        }
        if (grain === 'day') {
            const parts = val.split('-');
            return parts[2] || val;
        }
        return val;
    };

    // Summary chip label
    const chipLabel = (selected: string[], grain: string) => {
        if (selected.length === 0) return grain.charAt(0).toUpperCase() + grain.slice(1);
        if (selected.length === 1) return shortLabel(selected[0], grain);
        return `${selected.length} ${grain}s`;
    };

    return (
        <React.Fragment>
            <span className="text-teal-400 font-semibold self-center">and</span>

            {/* Date Column Selector */}
            <div className="relative group inline-block">
                <select
                    value={filter.column}
                    onChange={e => { onUpdate(id, 'column', e.target.value); onUpdate(id, 'year', []); onUpdate(id, 'quarter', []); onUpdate(id, 'month', []); onUpdate(id, 'day', []); onUpdate(id, 'values', []); }}
                    className="appearance-none font-bold border-b-2 border-teal-400/40 rounded-lg px-3 py-1 pr-8 cursor-pointer text-sm focus:outline-none focus:ring-2 focus:ring-teal-400/50"
                    style={{ backgroundColor: '#134e4a', color: '#5eead4' }}
                >
                    {dateColumns.map(d => <option key={d} value={d} style={{ backgroundColor: '#134e4a', color: '#e2e8f0' }}>{d.replace(/_/g, ' ')}</option>)}
                </select>
                <ChevronDown className="w-4 h-4 text-teal-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            {/* Mode toggle */}
            <button
                onClick={toggleMode}
                className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold border transition-all self-center ${mode === 'range'
                    ? 'bg-orange-500/20 text-orange-300 border-orange-400/30 hover:bg-orange-500/30'
                    : 'bg-teal-500/20 text-teal-300 border-teal-400/30 hover:bg-teal-500/30'
                    }`}
                title={mode === 'hierarchy' ? 'Switch to date range picker' : 'Switch to hierarchical picker'}
            >
                <Calendar className="w-3 h-3" />
                {mode === 'hierarchy' ? 'Drill' : 'Range'}
            </button>

            {/* ═══ HIERARCHY MODE ═══ */}
            {mode === 'hierarchy' && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    {/* Year */}
                    <MultiSelectPicker
                        label="Year"
                        selected={selectedYears}
                        options={years}
                        formatLabel={v => v}
                        onToggle={v => toggleHierarchy('year', v)}
                        onClear={() => clearGrain('year')}
                        chipLabel={chipLabel(selectedYears, 'year')}
                        color="teal"
                    />

                    {/* Quarter — always visible when data available */}
                    {quarters.length > 0 && (
                        <>
                            <span className="text-slate-500 self-center">/</span>
                            <MultiSelectPicker
                                label="Quarter"
                                selected={selectedQuarters}
                                options={quarters}
                                formatLabel={v => shortLabel(v, 'quarter')}
                                onToggle={v => toggleHierarchy('quarter', v)}
                                onClear={() => clearGrain('quarter')}
                                chipLabel={chipLabel(selectedQuarters, 'quarter')}
                                color="indigo"
                            />
                        </>
                    )}

                    {/* Month — always visible when data available */}
                    {months.length > 0 && (
                        <>
                            <span className="text-slate-500 self-center">/</span>
                            <MultiSelectPicker
                                label="Month"
                                selected={selectedMonths}
                                options={months}
                                formatLabel={v => shortLabel(v, 'month')}
                                onToggle={v => toggleHierarchy('month', v)}
                                onClear={() => clearGrain('month')}
                                chipLabel={chipLabel(selectedMonths, 'month')}
                                color="violet"
                            />
                        </>
                    )}

                    {/* Day — visible when month or higher selected */}
                    {days.length > 0 && (
                        <>
                            <span className="text-slate-500 self-center">/</span>
                            <MultiSelectPicker
                                label="Day"
                                selected={selectedDays}
                                options={days}
                                formatLabel={v => shortLabel(v, 'day')}
                                onToggle={v => toggleHierarchy('day', v)}
                                onClear={() => clearGrain('day')}
                                chipLabel={chipLabel(selectedDays, 'day')}
                                color="rose"
                            />
                        </>
                    )}
                </div>
            )}

            {/* ═══ RANGE MODE ═══ */}
            {mode === 'range' && (
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-slate-500 font-semibold self-center">From</span>
                    <input
                        type="date"
                        value={rangeStart}
                        onChange={e => {
                            onUpdate(id, 'rangeStart', e.target.value);
                            onUpdate(id, 'mode', 'range');
                            if (e.target.value && rangeEnd) {
                                onUpdate(id, 'timeGrain', 'day');
                                onUpdate(id, 'values', [`${e.target.value}__${rangeEnd}`]);
                            }
                        }}
                        className="bg-white/10 border-2 border-orange-400/30 rounded-lg px-2.5 py-1 text-sm font-bold text-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-400/50 cursor-pointer"
                    />
                    <ArrowRight className="w-4 h-4 text-slate-500 self-center" />
                    <span className="text-xs text-slate-500 font-semibold self-center">To</span>
                    <input
                        type="date"
                        value={rangeEnd}
                        onChange={e => {
                            onUpdate(id, 'rangeEnd', e.target.value);
                            onUpdate(id, 'mode', 'range');
                            if (rangeStart && e.target.value) {
                                onUpdate(id, 'timeGrain', 'day');
                                onUpdate(id, 'values', [`${rangeStart}__${e.target.value}`]);
                            }
                        }}
                        className="bg-white/10 border-2 border-orange-400/30 rounded-lg px-2.5 py-1 text-sm font-bold text-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-400/50 cursor-pointer"
                    />
                </div>
            )}

            {/* Remove button */}
            <button
                onClick={() => onRemove(id)}
                className="text-red-400 hover:text-red-300 hover:bg-red-500/20 rounded p-1 transition-colors self-center"
                title="Remove filter"
            >
                <X className="w-4 h-4" />
            </button>
        </React.Fragment>
    );
};

/**
 * Multi-select dropdown for one hierarchy level.
 * Shows checkboxes next to each option, selected count in chip.
 */
const COLORS: Record<string, { bg: string; selected: string; text: string; border: string; check: string }> = {
    teal: { bg: 'bg-teal-500/15', selected: 'bg-teal-500/25', text: 'text-teal-300', border: 'border-teal-400/40', check: 'text-teal-400' },
    indigo: { bg: 'bg-indigo-500/15', selected: 'bg-indigo-500/25', text: 'text-indigo-300', border: 'border-indigo-400/40', check: 'text-indigo-400' },
    violet: { bg: 'bg-violet-500/15', selected: 'bg-violet-500/25', text: 'text-violet-300', border: 'border-violet-400/40', check: 'text-violet-400' },
    rose: { bg: 'bg-rose-500/15', selected: 'bg-rose-500/25', text: 'text-rose-300', border: 'border-rose-400/40', check: 'text-rose-400' },
};

const MultiSelectPicker: React.FC<{
    label: string;
    selected: string[];
    options: string[];
    formatLabel: (val: string) => string;
    onToggle: (val: string) => void;
    onClear: () => void;
    chipLabel: string;
    color: string;
}> = ({ label, selected, options, formatLabel, onToggle, onClear, chipLabel, color }) => {
    const [open, setOpen] = useState(false);
    const btnRef = useRef<HTMLButtonElement>(null);
    const dropRef = useRef<HTMLDivElement>(null);
    const [pos, setPos] = useState({ top: 0, left: 0 });
    const c = COLORS[color] || COLORS.teal;

    useEffect(() => {
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

    useEffect(() => {
        if (open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            setPos({ top: r.bottom + 4, left: r.left });
        }
    }, [open]);

    return (
        <div className="relative inline-block">
            <button
                ref={btnRef}
                onClick={() => setOpen(!open)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg border font-bold text-sm transition-all cursor-pointer ${selected.length > 0 ? `${c.selected} ${c.text} ${c.border}` : `${c.bg} text-slate-400 ${c.border}`
                    }`}
            >
                {chipLabel}
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
            </button>

            {open && ReactDOM.createPortal(
                <div
                    ref={dropRef}
                    className="fixed z-[9999] border border-white/15 rounded-xl shadow-2xl max-h-64 overflow-auto"
                    style={{ top: pos.top, left: pos.left, minWidth: 140, backgroundColor: '#0f172a' }}
                >
                    {/* Clear all */}
                    {selected.length > 0 && (
                        <button
                            onClick={() => { onClear(); }}
                            className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 font-medium border-b border-white/10"
                        >
                            ✕ Clear {label}
                        </button>
                    )}
                    {options.length === 0 ? (
                        <div className="px-3 py-2 text-xs text-slate-400">No values</div>
                    ) : (
                        options.map(opt => {
                            const isChecked = selected.includes(opt);
                            return (
                                <button
                                    key={opt}
                                    onClick={() => onToggle(opt)}
                                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors ${isChecked
                                        ? `${c.selected} ${c.text} font-bold`
                                        : 'hover:bg-white/10'
                                        }`}
                                    style={!isChecked ? { color: '#e2e8f0' } : undefined}
                                >
                                    <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${isChecked
                                        ? `${c.border} ${c.selected}`
                                        : 'border-slate-600'
                                        }`}>
                                        {isChecked && <Check className={`w-3 h-3 ${c.check}`} />}
                                    </span>
                                    {formatLabel(opt)}
                                </button>
                            );
                        })
                    )}
                </div>,
                document.body
            )}
        </div>
    );
};
