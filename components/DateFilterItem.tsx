import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, ChevronDown, Calendar, Search } from 'lucide-react';

interface DateFilterItemProps {
    id: number;
    filter: any;
    dateColumns: string[];
    getDateValues: (col: string, grain: string, selectedParentValues?: string[]) => string[];
    onUpdate: (id: number, field: string, value: any) => void;
    onRemove: (id: number) => void;
    onAddFilter?: (type: 'dimension' | 'measure' | 'date', column?: string, grain?: string) => void;
    selectedParentValues?: string[];
}

export const DateFilterItem: React.FC<DateFilterItemProps> = ({
    id, filter, dateColumns, getDateValues, onUpdate, onRemove, onAddFilter, selectedParentValues
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const selectedValues = Array.isArray(filter.values) ? filter.values : (filter.values ? [filter.values] : []);
    const timeGrain = filter.timeGrain || 'year';
    const [searchTerm, setSearchTerm] = useState('');

    const toggleValue = (val: string) => {
        const newValues = selectedValues.includes(val)
            ? selectedValues.filter((v: string) => v !== val)
            : [...selectedValues, val];
        onUpdate(id, 'values', newValues);
    };

    // Get available values - pass current selected values for hierarchical filtering
    const availableValues = filter.column
        ? getDateValues(filter.column, timeGrain, selectedParentValues)
        : [];

    return (
        <React.Fragment>
            <span className="text-teal-600 font-semibold self-center">and</span>

            {/* Date Column Selector */}
            <div className="relative group inline-block">
                <select
                    value={filter.column}
                    onChange={e => onUpdate(id, 'column', e.target.value)}
                    className="appearance-none bg-teal-50 hover:bg-teal-100 text-teal-700 font-bold border-b-2 border-teal-300 rounded px-3 py-1 pr-8 cursor-pointer text-base focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                    {dateColumns.map(d => <option key={d} value={d}>{d.replace(/_/g, ' ')}</option>)}
                </select>
                <ChevronDown className="w-4 h-4 text-teal-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            <span className="text-slate-500 self-center">in</span>

            {/* Time Grain Selector */}
            <div className="relative group inline-block">
                <select
                    value={timeGrain}
                    onChange={e => {
                        onUpdate(id, 'timeGrain', e.target.value);
                        // Reset values when grain changes
                        onUpdate(id, 'values', []);
                    }}
                    className="appearance-none bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold border-b-2 border-teal-300 rounded px-3 py-1 pr-8 cursor-pointer text-base focus:outline-none focus:ring-2 focus:ring-teal-500"
                >
                    <option value="year">Year</option>
                    <option value="quarter">Quarter</option>
                    <option value="month">Month</option>
                    <option value="week">Week</option>
                    <option value="day">Day</option>
                </select>
                <ChevronDown className="w-4 h-4 text-slate-500 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>

            {/* Value Multi-Select */}
            <div className="relative inline-block" ref={dropdownRef}>
                <button
                    type="button"
                    onClick={() => setIsOpen(!isOpen)}
                    className="appearance-none bg-white hover:bg-slate-50 text-slate-800 font-bold border-2 border-teal-300 rounded px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-teal-500 min-w-[140px] text-left flex items-center justify-between"
                >
                    <span className="truncate flex items-center gap-1">
                        <Calendar className="w-3.5 h-3.5 text-teal-600" />
                        {selectedValues.length === 0 ? 'Select...' :
                            selectedValues.length === 1 ? selectedValues[0] :
                                `${selectedValues.length} selected`}
                    </span>
                    <ChevronDown className="w-4 h-4 text-slate-500 ml-2" />
                </button>

                {isOpen && (
                    <div className="absolute z-50 mt-1 w-full max-w-xs bg-white border-2 border-teal-300 rounded-md shadow-lg">
                        {/* Search */}
                        <div className="px-2 pt-2 pb-1">
                            <div className="relative">
                                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                                <input
                                    type="text"
                                    placeholder="Search..."
                                    value={searchTerm}
                                    onChange={e => setSearchTerm(e.target.value)}
                                    className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-teal-400"
                                    onClick={e => e.stopPropagation()}
                                />
                            </div>
                        </div>
                        <div className="max-h-52 overflow-auto">
                            {availableValues.filter(v => v.toLowerCase().includes(searchTerm.toLowerCase())).length === 0 ? (
                                <div className="px-3 py-2 text-sm text-slate-500">No values</div>
                            ) : (
                                availableValues.filter(v => v.toLowerCase().includes(searchTerm.toLowerCase())).map(val => (
                                    <label
                                        key={val}
                                        className="flex items-center px-3 py-2 hover:bg-teal-50 cursor-pointer text-sm"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={selectedValues.includes(val)}
                                            onChange={() => toggleValue(val)}
                                            className="mr-2 rounded border-teal-300 text-teal-600 focus:ring-teal-500"
                                        />
                                        <span>{val}</span>
                                    </label>
                                ))
                            )}
                        </div>
                    </div>
                )}
            </div>

            <button
                onClick={() => onRemove(id)}
                className="text-red-500 hover:text-red-700 hover:bg-red-50 rounded p-1 transition-colors self-center"
                title="Remove filter"
            >
                <X className="w-4 h-4" />
            </button>
        </React.Fragment>
    );
};
