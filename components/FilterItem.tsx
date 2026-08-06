import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { X, ChevronDown, Search } from 'lucide-react';
import { QuerySelect } from './QuerySelect';

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
    const [dropdownPos, setDropdownPos] = useState<{
        top: number;
        left: number;
        width: number;
        maxHeight: number;
        placement: 'up' | 'down';
    }>({ top: 0, left: 0, width: 200, maxHeight: 280, placement: 'down' });

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

    // Place the value picker on the side with usable viewport space.
    useEffect(() => {
        if (!isOpen || !buttonRef.current) return;
        const updatePosition = () => {
            const rect = buttonRef.current?.getBoundingClientRect();
            if (!rect) return;
            const gap = 6;
            const viewportPadding = 8;
            const desiredHeight = 280;
            const availableAbove = Math.max(0, rect.top - viewportPadding - gap);
            const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - gap);
            const placement: 'up' | 'down' =
                availableBelow >= desiredHeight || availableBelow >= availableAbove ? 'down' : 'up';
            const availableHeight = placement === 'up' ? availableAbove : availableBelow;
            const width = Math.min(320, Math.max(rect.width, 220));
            setDropdownPos({
                top: placement === 'up' ? rect.top - gap : rect.bottom + gap,
                left: Math.max(viewportPadding, Math.min(rect.left, window.innerWidth - width - viewportPadding)),
                width,
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
                                className="qi-dropdown-surface qi-filter-value-menu fixed z-[9999] border border-purple-400/30 rounded-xl shadow-2xl"
                                style={{
                                    top: dropdownPos.top,
                                    left: dropdownPos.left,
                                    width: dropdownPos.width,
                                    maxWidth: 320,
                                    maxHeight: dropdownPos.maxHeight,
                                    overflow: 'hidden',
                                    backgroundColor: '#0f172a',
                                    transform: dropdownPos.placement === 'up' ? 'translateY(-100%)' : 'none',
                                    transformOrigin: dropdownPos.placement === 'up' ? 'bottom left' : 'top left'
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
                                <div className="overflow-auto" style={{ maxHeight: Math.max(44, dropdownPos.maxHeight - 52) }}>
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
                        <QuerySelect
                            menuPlacement="auto"
                            value={filter.column}
                            onChange={value => onUpdate(id, 'column', value)}
                            options={columnOptions.map(m => ({ label: m.replace(/_/g, ' '), value: m }))}
                            colorTextClass="text-blue-400"
                            colorRingClass="focus:ring-blue-400/50"
                            searchable={false}
                            className="min-w-[140px] !py-1 !pl-3 !pr-2 !bg-[#1e3a5f] !border-blue-400/40"
                        />
                    </div>

                    <div className="relative group inline-block">
                        <QuerySelect
                            menuPlacement="auto"
                            value={filter.operator}
                            onChange={value => onUpdate(id, 'operator', value)}
                            options={[
                                { label: '≥', value: '>=' },
                                { label: '≤', value: '<=' },
                                { label: '=', value: '=' },
                                { label: '≠', value: '!=' },
                                { label: '>', value: '>' },
                                { label: '<', value: '<' },
                            ]}
                            colorTextClass="text-blue-300"
                            colorRingClass="focus:ring-blue-400/50"
                            searchable={false}
                            className="min-w-[72px] !py-1 !pl-2 !pr-1 !bg-[#1e293b] !border-blue-400/30"
                        />
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

