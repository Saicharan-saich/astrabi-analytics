import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { X, ChevronDown, Search } from 'lucide-react';

interface FilterItemProps {
    id: number;
    filter: any;
    dims: string[];
    metrics: string[];
    getColumnValues: (col: string) => string[];
    onUpdate: (id: number, field: string, value: any) => void;
    onRemove: (id: number) => void;
}

export const FilterItem: React.FC<FilterItemProps> = ({
    id, filter, dims, metrics, getColumnValues, onUpdate, onRemove
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 200 });

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node) &&
                buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Compute position when dropdown opens
    useEffect(() => {
        if (isOpen && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setDropdownPos({
                top: rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 220)
            });
        }
    }, [isOpen]);

    const selectedValues = Array.isArray(filter.value) ? filter.value : (filter.value ? [filter.value] : []);
    const [searchTerm, setSearchTerm] = useState('');

    const toggleValue = (val: string) => {
        const newValues = selectedValues.includes(val)
            ? selectedValues.filter((v: string) => v !== val)
            : [...selectedValues, val];
        onUpdate(id, 'value', newValues);
    };

    const availableValues = filter.type === 'dimension' && filter.column ? getColumnValues(filter.column) : [];
    const columnOptions = filter.type === 'dimension' ? dims : metrics;

    return (
        <React.Fragment>
            <span className="text-purple-400 font-semibold self-center">and</span>

            {filter.type === 'dimension' ? (
                <>
                    {/* Dimension Filter with Multi-Select */}
                    <div className="relative group inline-block">
                        <select
                            value={filter.column}
                            onChange={e => onUpdate(id, 'column', e.target.value)}
                            className="appearance-none font-bold border-b-2 border-purple-400/40 rounded-lg px-3 py-1 pr-8 cursor-pointer text-sm focus:outline-none focus:ring-2 focus:ring-purple-400/50"
                            style={{ backgroundColor: '#1e1b4b', color: '#c4b5fd' }}
                        >
                            {columnOptions.map(d => <option key={d} value={d} style={{ backgroundColor: '#1e1b4b', color: '#e2e8f0' }}>{d.replace(/_/g, ' ')}</option>)}
                        </select>
                        <ChevronDown className="w-4 h-4 text-purple-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>

                    <span className="text-slate-500 self-center text-sm">is</span>

                    <div className="relative inline-block">
                        <button
                            ref={buttonRef}
                            type="button"
                            onClick={() => setIsOpen(!isOpen)}
                            className="appearance-none bg-white/10 hover:bg-white/15 text-slate-300 font-bold border-2 border-purple-400/30 rounded-lg px-3 py-1 pr-8 cursor-pointer focus:outline-none focus:ring-2 focus:ring-purple-400/50 min-w-[140px] text-left flex items-center justify-between text-sm"
                        >
                            <span className="truncate">
                                {selectedValues.length === 0 ? 'Select...' :
                                    selectedValues.length === 1 ? selectedValues[0] :
                                        `${selectedValues.length} selected`}
                            </span>
                            <ChevronDown className="w-4 h-4 text-slate-400 ml-2" />
                        </button>

                        {isOpen && ReactDOM.createPortal(
                            <div
                                ref={dropdownRef}
                                className="fixed z-[9999] border border-purple-400/30 rounded-xl shadow-2xl"
                                style={{
                                    top: dropdownPos.top,
                                    left: dropdownPos.left,
                                    width: dropdownPos.width,
                                    maxWidth: 320,
                                    backgroundColor: '#0f172a'
                                }}
                            >
                                {/* Search */}
                                <div className="px-2 pt-2 pb-1">
                                    <div className="relative">
                                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2" />
                                        <input
                                            type="text"
                                            placeholder="Search..."
                                            value={searchTerm}
                                            onChange={e => setSearchTerm(e.target.value)}
                                            className="w-full pl-7 pr-2 py-1.5 text-xs border border-white/15 rounded bg-white/10 text-slate-300 focus:outline-none focus:ring-1 focus:ring-purple-400 placeholder-slate-500"
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
                                                className="flex items-center px-3 py-2 hover:bg-purple-500/20 cursor-pointer text-sm text-slate-300"
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedValues.includes(val)}
                                                    onChange={() => toggleValue(val)}
                                                    className="mr-2 rounded border-purple-300 text-purple-600 focus:ring-purple-500"
                                                />
                                                <span className="text-slate-300">{val}</span>
                                            </label>
                                        ))
                                    )}
                                </div>
                            </div>
                            , document.body)}
                    </div>
                </>
            ) : (
                <>
                    {/* Measure Filter */}
                    <div className="relative group inline-block">
                        <select
                            value={filter.column}
                            onChange={e => onUpdate(id, 'column', e.target.value)}
                            className="appearance-none font-bold border-b-2 border-blue-400/40 rounded-lg px-3 py-1 pr-8 cursor-pointer text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                            style={{ backgroundColor: '#1e3a5f', color: '#93c5fd' }}
                        >
                            {columnOptions.map(m => <option key={m} value={m} style={{ backgroundColor: '#1e3a5f', color: '#e2e8f0' }}>{m.replace(/_/g, ' ')}</option>)}
                        </select>
                        <ChevronDown className="w-4 h-4 text-blue-400 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>

                    <div className="relative group inline-block">
                        <select
                            value={filter.operator}
                            onChange={e => onUpdate(id, 'operator', e.target.value)}
                            className="appearance-none font-bold border-2 border-blue-400/30 rounded-lg px-2 py-1 pr-6 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/50"
                            style={{ backgroundColor: '#1e293b', color: '#cbd5e1' }}
                        >
                            <option value=">=" style={{ backgroundColor: '#1e293b', color: '#e2e8f0' }}>&gt;=</option>
                            <option value="<=" style={{ backgroundColor: '#1e293b', color: '#e2e8f0' }}>&lt;=</option>
                            <option value="=" style={{ backgroundColor: '#1e293b', color: '#e2e8f0' }}>=</option>
                            <option value="!=" style={{ backgroundColor: '#1e293b', color: '#e2e8f0' }}>!=</option>
                            <option value=">" style={{ backgroundColor: '#1e293b', color: '#e2e8f0' }}>&gt;</option>
                            <option value="<" style={{ backgroundColor: '#1e293b', color: '#e2e8f0' }}>&lt;</option>
                        </select>
                        <ChevronDown className="w-3 h-3 text-slate-500 absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>

                    <input
                        type="number"
                        value={filter.value}
                        onChange={e => onUpdate(id, 'value', parseFloat(e.target.value) || 0)}
                        className="bg-white/10 text-slate-300 font-bold border-2 border-blue-400/30 rounded-lg px-3 py-1 w-28 focus:ring-2 focus:ring-blue-400/50 outline-none text-sm"
                        placeholder="0"
                    />
                </>
            )}

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

