import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Printer, X } from 'lucide-react';
import type { CleaningSetup } from '../types';
import { useSetupStore } from '../store/useSetupStore';
import { buildHandover } from '../utils/setupHandover';

/**
 * The handover page for a saved cleaning setup: what the client keeps after a
 * setup session. Plain words, printable (or saved as a PDF from the print
 * dialog), with a note from the people who set it up.
 */
export const SetupHandover: React.FC<{ setup: CleaningSetup; onClose: () => void }> = ({ setup, onClose }) => {
    const saveSetup = useSetupStore(state => state.saveSetup);
    const handover = useMemo(() => buildHandover(setup), [setup]);
    const [notes, setNotes] = useState(setup.notes || '');
    const [saved, setSaved] = useState(false);
    const closeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        document.body.classList.add('qi-printing-handover');
        return () => { window.removeEventListener('keydown', onKey); document.body.classList.remove('qi-printing-handover'); };
    }, [onClose]);

    const saveNotes = () => {
        saveSetup({ ...setup, notes: notes.trim() || undefined, updatedAt: Date.now() });
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
    };

    return (
        <div className="qi-handover-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
            <article className="qi-handover" role="dialog" aria-modal="true" aria-labelledby="qi-handover-title">
                <div className="qi-handover-bar qi-no-print">
                    <span>Handover page</span>
                    <div className="flex gap-2">
                        <button type="button" className="qi-review-apply" onClick={() => window.print()}><Printer className="h-4 w-4" aria-hidden /> Print or save as PDF</button>
                        <button ref={closeRef} type="button" className="qi-steps-icon" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></button>
                    </div>
                </div>

                <header className="qi-handover-head">
                    <p className="qi-handover-kicker">Cleaning setup</p>
                    <h2 id="qi-handover-title">{handover.title}</h2>
                    <p>{handover.summary}</p>
                    <dl className="qi-handover-facts">
                        {handover.facts.map(fact => <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>)}
                    </dl>
                </header>

                <section className="qi-handover-section">
                    <h3>Notes from your data team</h3>
                    <textarea className="qi-steps-input qi-no-print" rows={3} value={notes} onChange={event => setNotes(event.target.value)} aria-label="Notes from your data team"
                        placeholder="e.g. Export the Sales report from the till system on the first working day of each month and upload it here." />
                    <div className="qi-no-print flex items-center gap-2">
                        <button type="button" className="qi-chk-undo" onClick={saveNotes} disabled={notes.trim() === (setup.notes || '').trim()}>Save notes</button>
                        {saved && <span className="qi-setup-meta" role="status"><Check className="inline h-3 w-3" aria-hidden /> Saved with the setup</span>}
                    </div>
                    <p className="qi-handover-printnotes">{notes.trim() || 'No notes.'}</p>
                </section>

                {handover.sections.map(section => (
                    <section key={section.id} className="qi-handover-section" aria-labelledby={`qi-handover-${section.id}`}>
                        <h3 id={`qi-handover-${section.id}`}>{section.title}</h3>
                        {section.intro && <p className="qi-handover-intro">{section.intro}</p>}
                        {section.columns && (
                            <table className="qi-handover-table">
                                <thead><tr><th>Column</th><th>What it is</th></tr></thead>
                                <tbody>{section.columns.map(column => <tr key={column.name}><td>{column.name}</td><td>{column.kind}</td></tr>)}</tbody>
                            </table>
                        )}
                        {section.items.length > 0 && (
                            <ol className={section.id === 'steps' ? 'is-numbered' : ''}>
                                {section.items.map((item, i) => (
                                    <li key={i} className={item.off ? 'is-off' : ''}>
                                        <span>{item.text}{item.off ? ' (switched off)' : ''}</span>
                                        {item.why && <em>Why: {item.why}</em>}
                                    </li>
                                ))}
                            </ol>
                        )}
                    </section>
                ))}

                <footer className="qi-handover-foot">Prepared with QuickInsight. This page describes cleaning choices and column names only; it contains none of your data.</footer>
            </article>
        </div>
    );
};
