/**
 * Tooltip — lightweight, reusable hover tooltip component.
 * CSS-only positioning, no external dependencies.
 */
import React, { useState, useRef, useCallback } from 'react';

interface TooltipProps {
    text: string;
    children: React.ReactNode;
    position?: 'top' | 'bottom' | 'left' | 'right';
    delay?: number;
    maxWidth?: number;
}

export const Tooltip: React.FC<TooltipProps> = ({
    text,
    children,
    position = 'top',
    delay = 300,
    maxWidth = 260,
}) => {
    const [visible, setVisible] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = useCallback(() => {
        timerRef.current = setTimeout(() => setVisible(true), delay);
    }, [delay]);

    const hide = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setVisible(false);
    }, []);

    const positionClasses: Record<string, string> = {
        top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
        bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
        left: 'right-full top-1/2 -translate-y-1/2 mr-2',
        right: 'left-full top-1/2 -translate-y-1/2 ml-2',
    };

    const arrowClasses: Record<string, string> = {
        top: 'top-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-b-transparent border-t-slate-800',
        bottom: 'bottom-full left-1/2 -translate-x-1/2 border-l-transparent border-r-transparent border-t-transparent border-b-slate-800',
        left: 'left-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-r-transparent border-l-slate-800',
        right: 'right-full top-1/2 -translate-y-1/2 border-t-transparent border-b-transparent border-l-transparent border-r-slate-800',
    };

    if (!text) return <>{children}</>;

    return (
        <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
            {children}
            {visible && (
                <span
                    className={`absolute z-[9999] ${positionClasses[position]} pointer-events-none animate-in fade-in duration-150`}
                    style={{ maxWidth }}
                >
                    <span className="block bg-slate-800 text-white text-xs font-medium px-3 py-2 rounded-lg shadow-xl border border-white/10 leading-relaxed whitespace-normal">
                        {text}
                    </span>
                    <span className={`absolute w-0 h-0 border-4 ${arrowClasses[position]}`} />
                </span>
            )}
        </span>
    );
};
