/**
 * Shown the moment an upload or a connection has been cleaned: what the data
 * holds, what the cleaning did, and two ways on — look at the changes, or
 * start asking questions in AI SQL.
 */
import { useEffect, useMemo, useRef } from 'react';
import { ArrowRight, CheckCircle2, Eye, Link2, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import type { Dataset } from '../types';
import { summariseDataReady } from '../services/dataReadySummary';

interface Props {
    dataset: Dataset;
    source: 'upload' | 'connector' | 'sample';
    onViewChanges: () => void;
    onContinue: () => void;
    onClose: () => void;
}

export function DataReadyDialog({ dataset, source, onViewChanges, onContinue, onClose }: Props) {
    const summary = useMemo(() => summariseDataReady(dataset), [dataset]);
    const panel = useRef<HTMLDivElement>(null);
    const primary = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        primary.current?.focus();
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
            if (event.key !== 'Tab' || !panel.current) return;
            // Keep keyboard focus inside the dialog.
            const items = [...panel.current.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')];
            if (!items.length) return;
            const first = items[0], last = items[items.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const title = source === 'connector' ? 'Your data is connected, cleaned and ready for analysis'
        : source === 'sample' ? 'The sample data is cleaned and ready for analysis'
            : 'Your data is cleaned and ready for analysis';
    return (
        <div className="qi-ready-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <div ref={panel} className="qi-ready" role="dialog" aria-modal="true" aria-labelledby="qi-ready-title" aria-describedby="qi-ready-lead">
                <button type="button" className="qi-ready-close" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></button>
                <div className="qi-ready-mark" aria-hidden><CheckCircle2 className="h-6 w-6" /></div>
                <h2 id="qi-ready-title">{title}</h2>
                <p id="qi-ready-lead" className="qi-ready-facts"><strong>{summary.name}</strong> · {summary.facts}</p>

                <div className="qi-ready-body">
                    <section aria-label="What the cleaning did">
                        <h3>What we did</h3>
                        {summary.changes.length ? (
                            <ul className="qi-ready-list">
                                {summary.changes.map(change => <li key={change}>{change}</li>)}
                                {summary.moreChanges > 0 && <li className="is-more">and {summary.moreChanges} more {summary.moreChanges === 1 ? 'change' : 'changes'}</li>}
                            </ul>
                        ) : (
                            <p className="qi-ready-muted">Nothing needed fixing: the dates, numbers and categories were already tidy.</p>
                        )}
                    </section>
                    {summary.links.length > 0 && (
                        <section aria-label="How the sheets were linked">
                            <h3><Link2 className="h-3.5 w-3.5" aria-hidden /> {summary.tables} {source === 'connector' ? 'tables' : 'sheets'} linked</h3>
                            <p className="qi-ready-links">{summary.links.join(' · ')}</p>
                        </section>
                    )}
                    {summary.toCheck > 0 && (
                        <p className="qi-ready-check"><TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />
                            <span>{summary.toCheck === 1 ? '1 thing is' : `${summary.toCheck} things are`} worth a quick look. We left {summary.toCheck === 1 ? 'it' : 'them'} as {summary.toCheck === 1 ? 'it was' : 'they were'}; you can check whenever you like.</span>
                        </p>
                    )}
                    <p className="qi-ready-private"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden /> Cleaned in your browser. Your rows never leave this computer.</p>
                </div>

                <div className="qi-ready-actions">
                    <button type="button" className="qi-ready-secondary" onClick={onViewChanges}>
                        <Eye className="h-4 w-4" aria-hidden /> View data changes
                    </button>
                    <button ref={primary} type="button" className="qi-ready-primary" onClick={onContinue}>
                        Continue to AI SQL <ArrowRight className="h-4 w-4" aria-hidden />
                    </button>
                </div>
            </div>
        </div>
    );
}
