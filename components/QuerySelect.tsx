import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
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
    colorTextClass?: string;
    colorRingClass?: string;
    className?: string;
    buttonContent?: React.ReactNode;
    menuPlacement?: 'auto' | 'up' | 'down';
}

interface MenuPosition {
    top: number;
    left: number;
    width: number;
    maxHeight: number;
    placement: 'up' | 'down';
    detached: boolean;
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
    buttonContent,
    menuPlacement = 'auto'
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [menuPosition, setMenuPosition] = useState<MenuPosition>({
        top: 0,
        left: 8,
        width: 240,
        maxHeight: 300,
        placement: 'down',
        detached: false,
    });
    const containerRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);

    const groupedOptions = options.reduce((acc, opt) => {
        const group = opt.group || 'default';
        if (!acc[group]) acc[group] = [];
        acc[group].push(opt);
        return acc;
    }, {} as Record<string, SelectOption[]>);
    const groupHeaderCount = Object.keys(groupedOptions).filter(group => group !== 'default').length;

    const filteredGroups = Object.entries(groupedOptions).reduce((acc, [group, opts]) => {
        const filtered = opts.filter(o => o.label.toLowerCase().includes(searchQuery.toLowerCase()));
        if (filtered.length > 0) acc[group] = filtered;
        return acc;
    }, {} as Record<string, SelectOption[]>);

    const updateMenuPosition = useCallback(() => {
        const button = buttonRef.current;
        if (!button) return;

        const rect = button.getBoundingClientRect();
        const viewportPadding = 8;
        const gap = 6;
        const availableAbove = Math.max(0, rect.top - viewportPadding - gap);
        const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - gap);
        // Calculate a stable natural requirement from the option model. The
        // rendered menu contains an inner scrolling flex child, so the root's
        // scrollHeight may itself reflect an earlier maxHeight constraint.
        // Never let that constrained measurement reduce the model estimate.
        const estimatedHeight = Math.min(
            480,
            Math.max(96, (searchable ? 58 : 8) + Math.max(1, options.length) * 39 + groupHeaderCount * 25)
        );
        const measuredContentHeight = menuRef.current?.scrollHeight ?? 0;
        const desiredHeight = Math.min(480, Math.max(estimatedHeight, measuredContentHeight));

        let placement: 'up' | 'down';
        if (menuPlacement === 'auto') {
            placement = availableBelow >= desiredHeight || availableBelow >= availableAbove ? 'down' : 'up';
        } else {
            const requestedSpace = menuPlacement === 'up' ? availableAbove : availableBelow;
            const oppositeSpace = menuPlacement === 'up' ? availableBelow : availableAbove;
            placement = requestedSpace < 96 && oppositeSpace > requestedSpace
                ? (menuPlacement === 'up' ? 'down' : 'up')
                : menuPlacement;
        }

        const availableHeight = placement === 'up' ? availableAbove : availableBelow;
        const viewportHeight = Math.max(96, window.innerHeight - viewportPadding * 2);
        const targetHeight = Math.min(desiredHeight, viewportHeight);
        // When both anchored sides are cramped, use a viewport-contained
        // popover instead of reducing the choices to a tiny scroll window.
        const detached = Math.max(availableAbove, availableBelow) < targetHeight;
        const minMenuWidth = Math.min(240, Math.max(160, window.innerWidth - viewportPadding * 2));
        const width = Math.min(320, Math.max(rect.width, minMenuWidth));
        const left = Math.max(
            viewportPadding,
            Math.min(rect.left, window.innerWidth - width - viewportPadding)
        );

        setMenuPosition({
            top: detached
                ? Math.max(viewportPadding, Math.min(
                    rect.top + rect.height / 2 - targetHeight / 2,
                    window.innerHeight - targetHeight - viewportPadding
                ))
                : placement === 'up' ? rect.top - gap : rect.bottom + gap,
            left,
            width,
            maxHeight: detached ? targetHeight : Math.max(96, Math.min(targetHeight, availableHeight)),
            placement,
            detached,
        });
    }, [groupHeaderCount, menuPlacement, options.length, searchable]);

    useEffect(() => {
        if (!isOpen) return;

        updateMenuPosition();
        const frame = requestAnimationFrame(updateMenuPosition);
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as Node;
            if (!containerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
                setIsOpen(false);
            }
        };
        const handleViewportChange = () => updateMenuPosition();

        document.addEventListener('mousedown', handleClickOutside);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);

        if (searchable) {
            window.setTimeout(() => searchRef.current?.focus(), 50);
        }

        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('mousedown', handleClickOutside);
            window.removeEventListener('resize', handleViewportChange);
            window.removeEventListener('scroll', handleViewportChange, true);
        };
    }, [isOpen, searchable, updateMenuPosition]);

    const handleSelect = (val: string) => {
        onChange(val);
        setIsOpen(false);
        setSearchQuery('');
    };

    const selectedOption = options.find(o => o.value === value);
    const optionsMaxHeight = Math.max(64, menuPosition.maxHeight - (searchable ? 58 : 8));

    return (
        <div className="relative inline-block" ref={containerRef}>
            <button
                ref={buttonRef}
                type="button"
                aria-haspopup="listbox"
                aria-expanded={isOpen}
                onClick={() => {
                    if (!isOpen) updateMenuPosition();
                    setIsOpen(!isOpen);
                }}
                className={`flex items-center justify-between gap-3 bg-white/5 border rounded-xl py-2 pl-4 pr-3 transition-all outline-none focus:ring-2 ${isOpen ? `bg-white/10 ${colorRingClass} border-white/20` : 'border-white/10 hover:bg-white/8 hover:border-white/20'} ${className}`}
            >
                {buttonContent ? (
                    buttonContent
                ) : (
                    <div className="flex items-center gap-2 min-w-0">
                        {icon && <span className={colorTextClass}>{icon}</span>}
                        <span className={`truncate text-sm font-semibold ${selectedOption ? 'text-white' : 'text-slate-400'}`}>
                            {selectedOption ? selectedOption.label : placeholder}
                        </span>
                    </div>
                )}
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180 text-white' : 'text-slate-400'}`} />
            </button>

            {isOpen && ReactDOM.createPortal(
                <div
                    ref={menuRef}
                    role="listbox"
                    className={`qi-dropdown-surface qi-query-select-menu fixed z-[9999] flex flex-col rounded-2xl overflow-hidden shadow-2xl animate-in fade-in duration-150 ${menuPosition.placement === 'up' ? 'slide-in-from-bottom-2' : 'slide-in-from-top-2'}`}
                    data-placement={menuPosition.placement}
                    data-detached={menuPosition.detached ? 'true' : 'false'}
                    style={{
                        position: 'fixed',
                        top: menuPosition.top,
                        bottom: 'auto',
                        left: menuPosition.left,
                        width: menuPosition.width,
                        maxWidth: 'calc(100vw - 16px)',
                        maxHeight: menuPosition.maxHeight,
                        transform: !menuPosition.detached && menuPosition.placement === 'up' ? 'translateY(-100%)' : 'none',
                        transformOrigin: menuPosition.detached ? 'center' : menuPosition.placement === 'up' ? 'bottom left' : 'top left',
                        backgroundColor: '#0f172a',
                        border: '1px solid #475569',
                    }}
                >
                    {searchable && (
                        <div className="p-2 border-b border-white/5 shrink-0">
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

                    <div
                        className="overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
                        style={{ maxHeight: optionsMaxHeight }}
                    >
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
                                            type="button"
                                            role="option"
                                            aria-selected={value === opt.value}
                                            onClick={() => handleSelect(opt.value)}
                                            className={`qi-dropdown-option w-full flex items-center justify-between text-left px-3 py-2 rounded-lg text-sm font-semibold transition-all ${value === opt.value
                                                ? `qi-dropdown-option--selected bg-white/10 ${colorTextClass}`
                                                : 'hover:bg-white/10'
                                                }`}
                                            style={value !== opt.value ? { color: '#e2e8f0' } : undefined}
                                        >
                                            {opt.label}
                                            {value === opt.value && <Check className="w-4 h-4" />}
                                        </button>
                                    ))}
                                </div>
                            ))
                        )}
                    </div>
                </div>,
                document.body
            )}
        </div>
    );
};
