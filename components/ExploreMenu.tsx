import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Filter, FilterX, Layers, Rows3, X } from 'lucide-react';
import type { DrillOption } from '../utils/explore';

export interface ExploreAction {
    id: string;
    label: string;
    hint?: string;
    icon?: 'keep' | 'exclude' | 'rows' | 'clear' | 'open';
    onSelect: () => void;
}

interface ExploreMenuProps {
    anchor: { x: number; y: number };
    /** What was clicked, e.g. "Electronics". */
    title: string;
    /** Context line, e.g. "Contoso · Revenue 12.3K". */
    context?: string;
    actions: ExploreAction[];
    drill?: { heading: string; options: DrillOption[]; onSelect: (option: DrillOption) => void };
    onClose: () => void;
}

const ICONS = {
    keep: Filter,
    exclude: FilterX,
    rows: Rows3,
    clear: X,
    open: ChevronRight,
};

/**
 * The menu that opens where a chart mark was clicked: show only, exclude,
 * break down by…, see the rows. Keyboard: arrows move, Enter picks, Esc closes.
 */
export const ExploreMenu: React.FC<ExploreMenuProps> = ({ anchor, title, context, actions, drill, onClose }) => {
    const ref = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number }>({ left: anchor.x + 8, top: anchor.y + 8 });

    // Keep the menu on screen: open below-right of the click, flip when needed.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const { width, height } = el.getBoundingClientRect();
        const margin = 12;
        let left = anchor.x + 8;
        let top = anchor.y + 8;
        if (left + width > window.innerWidth - margin) left = Math.max(margin, anchor.x - width - 8);
        if (top + height > window.innerHeight - margin) top = Math.max(margin, anchor.y - height - 8);
        setPosition({ left, top });
        el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }, [anchor.x, anchor.y]);

    useEffect(() => {
        const onPointer = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) onClose();
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
            if (!items.length) return;
            event.preventDefault();
            const at = items.indexOf(document.activeElement as HTMLElement);
            const next = event.key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
            items[next].focus();
        };
        const onScroll = () => onClose();
        // Defer so the click that opened the menu does not close it.
        const timer = window.setTimeout(() => {
            document.addEventListener('mousedown', onPointer);
            window.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', onScroll);
        }, 0);
        document.addEventListener('keydown', onKey);
        return () => {
            window.clearTimeout(timer);
            document.removeEventListener('mousedown', onPointer);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [onClose]);

    const pick = (fn: () => void) => () => { onClose(); fn(); };

    return createPortal(
        <div
            ref={ref}
            className="qi-explore-menu fixed z-[400] w-[284px] rounded-xl py-1.5"
            style={{ left: position.left, top: position.top }}
            role="menu"
            aria-label={`Explore ${title}`}
        >
            <div className="px-3.5 pt-1.5 pb-2">
                <div className="qi-explore-title text-[13.5px] font-semibold truncate" title={title}>{title}</div>
                {context && <div className="qi-explore-context text-[12px] truncate" title={context}>{context}</div>}
            </div>
            <div className="qi-explore-divider" />
            {actions.map(action => {
                const Icon = action.icon ? ICONS[action.icon] : null;
                return (
                    <button key={action.id} type="button" role="menuitem" onClick={pick(action.onSelect)} className="qi-explore-item w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px]">
                        {Icon ? <Icon className="qi-explore-icon w-4 h-4 shrink-0" /> : <span className="w-4" />}
                        <span className="flex-1 min-w-0 leading-[18px] break-words">{action.label}</span>
                        {action.hint && <span className="qi-explore-hint text-[11.5px] shrink-0">{action.hint}</span>}
                    </button>
                );
            })}
            {drill && drill.options.length > 0 && (
                <>
                    <div className="qi-explore-divider" />
                    <div className="qi-explore-heading flex items-center gap-2 px-3.5 pt-2 pb-1 text-[11.5px] font-semibold">
                        <Layers className="w-3.5 h-3.5" /> {drill.heading}
                    </div>
                    {drill.options.map(option => (
                        <button key={`${option.kind}:${option.value}`} type="button" role="menuitem" onClick={pick(() => drill.onSelect(option))} className="qi-explore-item w-full flex items-center gap-2.5 px-3.5 py-1.5 text-left text-[13px]">
                            <span className="w-4" />
                            <span className="flex-1 min-w-0 truncate">{option.label}</span>
                            <ChevronRight className="qi-explore-icon w-3.5 h-3.5 shrink-0" />
                        </button>
                    ))}
                </>
            )}
        </div>,
        document.body,
    );
};
