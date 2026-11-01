import React, { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

interface UnderlyingRowsDrawerProps {
    title: string;
    /** The conditions the rows meet, in words. */
    conditions: string[];
    rows: Record<string, any>[];
    /** Column order; defaults to the first row's keys. */
    columns?: string[];
    fileName?: string;
    onClose: () => void;
}

const SHOWN = 300;

/** The records behind a clicked bar or slice, with a CSV export. */
export const UnderlyingRowsDrawer: React.FC<UnderlyingRowsDrawerProps> = ({ title, conditions, rows, columns, fileName = 'rows', onClose }) => {
    const panelRef = useRef<HTMLDivElement>(null);
    const keys = useMemo(() => columns?.length ? columns : Object.keys(rows[0] || {}), [columns, rows]);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        panelRef.current?.focus();
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const exportCsv = () => {
        const escape = (v: any) => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [keys.map(escape).join(','), ...rows.map(row => keys.map(k => escape(row[k])).join(','))].join('\n');
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileName.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'rows'}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    return createPortal(
        <div className="fixed inset-0 z-[390] flex justify-end" role="presentation">
            <div className="qi-drawer-scrim absolute inset-0" onClick={onClose} />
            <div
                ref={panelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="qi-drawer relative h-full w-full max-w-[760px] flex flex-col outline-none"
            >
                <div className="qi-ws-toolbar flex items-start gap-3 px-5 py-4">
                    <div className="flex-1 min-w-0">
                        <h3 className="qi-ws-strong text-[15px] font-semibold">{title}</h3>
                        <p className="qi-ws-muted text-[12.5px] mt-0.5">
                            {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'}{conditions.length ? ` where ${conditions.join(' and ')}` : ''}
                        </p>
                    </div>
                    <button type="button" onClick={exportCsv} disabled={!rows.length} className="qi-ws-ghost inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-40">
                        <Download className="w-4 h-4" /> Export CSV
                    </button>
                    <button type="button" onClick={onClose} className="qi-step-chevron p-1.5 rounded-md" aria-label="Close">
                        <X className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex-1 overflow-auto">
                    {rows.length === 0 ? (
                        <p className="qi-ws-muted p-8 text-center text-[13px]">No rows match.</p>
                    ) : (
                        <table className="w-full text-[12.5px]">
                            <thead className="sticky top-0 z-10">
                                <tr className="qi-ws-thead">
                                    {keys.map(k => <th key={k} className="px-3 py-2 text-left whitespace-nowrap">{k}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {rows.slice(0, SHOWN).map((row, i) => (
                                    <tr key={i} className="qi-ws-row is-static">
                                        {keys.map(k => {
                                            const v = row[k];
                                            const empty = v === null || v === undefined || v === '';
                                            return <td key={k} className={`px-3 py-1.5 whitespace-nowrap max-w-[220px] truncate ${empty ? 'qi-ws-muted italic' : 'qi-ws-strong'}`}>{empty ? 'blank' : String(v)}</td>;
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
                {rows.length > SHOWN && (
                    <div className="qi-ws-toolbar is-bottom px-5 py-2.5 qi-ws-muted text-[12px]">
                        Showing the first {SHOWN.toLocaleString()} of {rows.length.toLocaleString()} — export to see them all.
                    </div>
                )}
            </div>
        </div>,
        document.body,
    );
};
