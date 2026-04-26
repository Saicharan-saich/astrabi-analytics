/**
 * Tooltip — lightweight, reusable hover tooltip component.
 * Renders via React portal so it fully escapes overflow-hidden containers.
 * Displays text horizontally in a wide, readable bubble.
 */
import React, { useState, useRef, useCallback, useLayoutEffect, useEffect } from 'react';
import ReactDOM from 'react-dom';

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
    maxWidth = 420,
}) => {
    const [visible, setVisible] = useState(false);
    const [coords, setCoords] = useState<{ top: number; left: number }>({ top: -9999, left: -9999 });
    const triggerRef = useRef<HTMLSpanElement>(null);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = useCallback(() => {
        timerRef.current = setTimeout(() => setVisible(true), delay);
    }, [delay]);

    const hide = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        setVisible(false);
    }, []);

    // Recalculate position after the tooltip renders and its size is known
    useLayoutEffect(() => {
        if (!visible || !triggerRef.current || !tooltipRef.current) return;

        const recalc = () => {
            const trigger = triggerRef.current!.getBoundingClientRect();
            const tip = tooltipRef.current!.getBoundingClientRect();
            const gap = 10;

            let top = 0;
            let left = 0;

            switch (position) {
                case 'right':
                    top = trigger.top + trigger.height / 2 - tip.height / 2;
                    left = trigger.right + gap;
                    break;
                case 'left':
                    top = trigger.top + trigger.height / 2 - tip.height / 2;
                    left = trigger.left - tip.width - gap;
                    break;
                case 'bottom':
                    top = trigger.bottom + gap;
                    left = trigger.left + trigger.width / 2 - tip.width / 2;
                    break;
                case 'top':
                default:
                    top = trigger.top - tip.height - gap;
                    left = trigger.left + trigger.width / 2 - tip.width / 2;
                    break;
            }

            // Clamp to viewport
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            if (left < 8) left = 8;
            if (left + tip.width > vw - 8) left = vw - tip.width - 8;
            if (top < 8) top = 8;
            if (top + tip.height > vh - 8) top = vh - tip.height - 8;

            setCoords({ top, left });
        };

        // Run twice: once immediately, once on next frame (after browser has laid out text wrapping)
        recalc();
        requestAnimationFrame(recalc);
    }, [visible, position]);

    if (!text) return <>{children}</>;

    return (
        <span ref={triggerRef} className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
            {children}
            {visible &&
                ReactDOM.createPortal(
                    <div
                        ref={tooltipRef}
                        style={{
                            position: 'fixed',
                            zIndex: 99999,
                            top: coords.top,
                            left: coords.left,
                            width: maxWidth,
                            maxWidth: maxWidth,
                            pointerEvents: 'none',
                        }}
                    >
                        <div
                            style={{
                                background: '#1e293b',
                                color: '#fff',
                                fontSize: '13px',
                                fontWeight: 500,
                                lineHeight: 1.5,
                                padding: '8px 14px',
                                borderRadius: '10px',
                                border: '1px solid rgba(255,255,255,0.1)',
                                boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
                                whiteSpace: 'normal',
                                wordBreak: 'break-word',
                            }}
                        >
                            {text}
                        </div>
                    </div>,
                    document.body
                )}
        </span>
    );
};
