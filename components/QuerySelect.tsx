import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';

export interface SelectOption {
    label: string;
    value: string;
    group?: string;
}

interface QuerySelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    icon?: React.ReactNode;
    placeholder?: string;
    searchable?: boolean;
    colorTextClass?: string; // e.g., 'text-purple-400'
    colorRingClass?: string; // e.g., 'focus:ring-purple-500/30'
    className?: string; // for custom width or padding overrides
    buttonContent?: React.ReactNode; // custom completely override button inner content
}

export const QuerySelect: React.FC<QuerySelectProps> = ({
    value,
    onChange,
    options,
    icon,
    placeholder = 'Select...',
    searchable = true,
    colorTextClass = 'text-white',
    colorRingClass = 'focus:ring-white/20',
    className = '',
    buttonContent
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const containerRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    // Group options
    const groupedOptions = options.reduce((acc, opt) => {
        const group = opt.group || 'default';
        if (!acc[group]) acc[group] = [];
        acc[group].push(opt);
        return acc;
    }, {} as Record<string, SelectOption[]>);

    // Filter by search
    const filteredGroups = Object.entries(groupedOptions).reduce((acc, [group, opts]) => {
        const filtered = opts.filter(o => o.label.toLowerCase().includes(searchQuery.toLowerCase()));
        if (filtered.length > 0) acc[group] = filtered;
        return acc;
    }, {} as Record<string, SelectOption[]>);

    // Close on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        if (isOpen) {
            document.addEventListener('mousedown', handleClickOutside);
            // Focus search input when opened
            if (searchable) {
                setTimeout(() => searchRef.current?.focus(), 50);
            }
        }
        return () => {
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [isOpen, searchable]);

    const handleSelect = (val: string) => {
        onChange(val);
        setIsOpen(false);
        setSearchQuery('');
    };

    const selectedOption = options.find(o => o.value === value);

    return (
        <div className="relative inline-block" ref={containerRef}>
            {/* TRIGGER BUTTON */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={`flex items-center justify-between gap-3 bg-white/5 border rounded-xl py-2 pl-4 pr-3 transition-all outline-none focus:ring-2 ${isOpen ? `bg-white/10 ${colorRingClass} border-white/20` : 'border-white/10 hover:bg-white/8 hover:border-white/20'} ${className}`}
            >
                {buttonContent ? (
                    buttonContent
                ) : (
                    <div className="flex items-center gap-2">
                        {icon && <span className={colorTextClass}>{icon}</span>}
                        <span className={`text-sm font-semibold ${selectedOption ? 'text-white' : 'text-slate-400'}`}>
                            {selectedOption ? selectedOption.label : placeholder}
                        </span>
                    </div>
                )}
                <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180 text-white' : 'text-slate-400'}`} />
            </button>

            {/* POPOVER DROPDOWN */}
            {isOpen && (
                <div
                    className="absolute z-[100] top-full mt-2 left-0 min-w-[240px] max-w-[320px] bg-slate-900 border border-slate-600 flex flex-col rounded-2xl overflow-hidden shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200"
                    style={{ transformOrigin: 'top left' }}
                >
                    {searchable && (
                        <div className="p-2 border-b border-white/5">
                            <div className="relative">
                                <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                                <input
                                    ref={searchRef}
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search..."
                                    className="w-full bg-black/20 text-white text-sm font-medium rounded-lg pl-9 pr-3 py-2 outline-none border border-transparent focus:border-white/20 transition-colors"
                                />
                            </div>
                        </div>
                    )}

                    <div className="max-h-[300px] overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                        {Object.keys(filteredGroups).length === 0 ? (
                            <div className="p-3 text-center text-sm text-slate-400 font-medium">No matches found</div>
                        ) : (
                            Object.entries(filteredGroups).map(([group, opts]) => (
                                <div key={group} className="mb-1 last:mb-0">
                                    {group !== 'default' && (
                                        <div className="px-3 py-1.5 text-[10px] font-bold tracking-wider text-slate-500 uppercase">
                                            {group}
                                        </div>
                                    )}
                                    {opts.map(opt => (
                                        <button
                                            key={opt.value}
                                            onClick={() => handleSelect(opt.value)}
                                            className={`w-full flex items-center justify-between text-left px-3 py-2 rounded-lg text-sm font-semibold transition-all ${value === opt.value
                                                    ? `bg-white/10 ${colorTextClass}`
                                                    : 'text-slate-300 hover:bg-white/5 hover:text-white'
                                                }`}
                                        >
                                            {opt.label}
                                            {value === opt.value && <Check className="w-4 h-4" />}
                                        </button>
                                    ))}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
