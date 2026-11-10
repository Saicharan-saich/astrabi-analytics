/**
 * For a store or database QuickInsight cannot connect to directly yet: how to
 * export the data from it, in that product's own words, and a button to
 * upload the file — instead of a "connection" that shows made-up rows.
 */
import { useEffect, useRef, type ChangeEvent } from 'react';
import { FileUp, Info, ShieldCheck, ShoppingBag, X } from 'lucide-react';
import type { SourceGuide } from '../services/sourceGuides';

interface Props {
    guide: SourceGuide;
    onFile: (event: ChangeEvent<HTMLInputElement>) => void;
    onClose: () => void;
}

export function SourceGuideDialog({ guide, onFile, onClose }: Props) {
    const primary = useRef<HTMLLabelElement>(null);
    useEffect(() => {
        primary.current?.focus();
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="qi-ready-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <div className="qi-ready qi-guide" role="dialog" aria-modal="true" aria-labelledby="qi-guide-title" aria-describedby="qi-guide-lead">
                <button type="button" className="qi-ready-close" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></button>
                <div className="qi-ready-mark qi-guide-mark" aria-hidden><ShoppingBag className="h-6 w-6" /></div>
                <h2 id="qi-guide-title">{guide.title}</h2>
                <p id="qi-guide-lead" className="qi-ready-facts">{guide.lead}</p>
                <div className="qi-ready-body">
                    <section aria-label={`How to export from ${guide.name}`}>
                        <h3>Three steps</h3>
                        <ol className="qi-guide-steps">
                            {guide.steps.map((step, index) => <li key={step}><span aria-hidden>{index + 1}</span>{step}</li>)}
                        </ol>
                    </section>
                    <p className="qi-ready-private"><Info className="h-4 w-4 shrink-0" aria-hidden /> {guide.weRead}</p>
                    {guide.caveat && <p className="qi-ready-check"><Info className="h-4 w-4 shrink-0" aria-hidden /> <span>{guide.caveat}</span></p>}
                    <p className="qi-ready-private"><ShieldCheck className="h-4 w-4 shrink-0" aria-hidden /> Cleaned in your browser. Your rows never leave this computer.</p>
                </div>
                <div className="qi-ready-actions">
                    <button type="button" className="qi-ready-secondary" onClick={onClose}>Not now</button>
                    <label ref={primary} tabIndex={0} className="qi-ready-primary qi-guide-upload"
                        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.click(); } }}>
                        <FileUp className="h-4 w-4" aria-hidden /> Upload the exported file
                        <input type="file" className="hidden" accept=".csv,.xlsx,.xls" onChange={event => { onClose(); onFile(event); }} />
                    </label>
                </div>
            </div>
        </div>
    );
}
