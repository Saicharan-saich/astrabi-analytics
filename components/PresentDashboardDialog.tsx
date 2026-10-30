import React, { useEffect, useMemo, useState } from 'react';
import { Presentation, X, CheckCircle2, AlertTriangle } from 'lucide-react';
import type { DashboardReadiness } from '../utils/presentationReadiness';

interface PresentDashboardDialogProps {
    dashboards: DashboardReadiness[];
    initialDashboardId?: string;
    onCancel: () => void;
    onStart: (dashboardId: string, onlyReady: boolean) => void;
}

/** Choose which dashboard to present, and whether to skip visuals without data. */
export const PresentDashboardDialog: React.FC<PresentDashboardDialogProps> = ({ dashboards, initialDashboardId, onCancel, onStart }) => {
    const [selectedId, setSelectedId] = useState(initialDashboardId || dashboards[0]?.id || '');
    const [onlyReady, setOnlyReady] = useState(true);
    const selected = useMemo(() => dashboards.find(d => d.id === selectedId), [dashboards, selectedId]);
    const slideCount = selected ? (onlyReady ? selected.ready : selected.total) : 0;

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onCancel]);

    return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4" onClick={onCancel}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="qi-present-title"
                className="qi-present-dialog w-full max-w-lg overflow-hidden"
                onClick={event => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
                    <div>
                        <h2 id="qi-present-title" className="qi-present-heading flex items-center gap-2 text-base font-semibold">
                            <Presentation className="h-4 w-4" aria-hidden="true" /> Present a dashboard
                        </h2>
                        <p className="qi-present-muted mt-1 text-[13px]">Choose the dashboard to show as full-screen slides.</p>
                    </div>
                    <button onClick={onCancel} aria-label="Close" className="qi-present-icon-button rounded-md p-1.5">
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div role="radiogroup" aria-label="Dashboard to present" className="max-h-[50vh] space-y-2 overflow-y-auto px-6 py-2">
                    {dashboards.map(dashboard => {
                        const active = dashboard.id === selectedId;
                        const allReady = dashboard.ready === dashboard.total;
                        return (
                            <button
                                key={dashboard.id}
                                role="radio"
                                aria-checked={active}
                                onClick={() => setSelectedId(dashboard.id)}
                                className={`qi-present-option w-full rounded-lg px-4 py-3 text-left ${active ? 'is-selected' : ''}`}
                            >
                                <div className="flex items-center justify-between gap-3">
                                    <span className="qi-present-heading truncate text-sm font-semibold">{dashboard.name}</span>
                                    <span className="qi-present-muted shrink-0 text-xs tabular-nums">
                                        {dashboard.total} visual{dashboard.total === 1 ? '' : 's'}
                                    </span>
                                </div>
                                <div className="mt-1.5 flex items-start gap-1.5 text-xs">
                                    {dashboard.total === 0 ? (
                                        <span className="qi-present-muted">No visuals yet</span>
                                    ) : allReady ? (
                                        <span className="qi-present-ok flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5" /> All visuals ready</span>
                                    ) : (
                                        <span className="qi-present-warn flex items-start gap-1.5">
                                            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
                                            <span>
                                                {dashboard.ready} of {dashboard.total} ready — the rest need {dashboard.missingDatasets.slice(0, 2).join(', ')}
                                                {dashboard.missingDatasets.length > 2 ? ` and ${dashboard.missingDatasets.length - 2} more` : ''} loaded
                                            </span>
                                        </span>
                                    )}
                                </div>
                            </button>
                        );
                    })}
                </div>

                <label className="qi-present-muted mx-6 mt-3 flex cursor-pointer items-center gap-2 text-[13px]">
                    <input type="checkbox" checked={onlyReady} onChange={event => setOnlyReady(event.target.checked)} className="h-4 w-4 rounded" />
                    Only present visuals whose data is loaded
                </label>

                <div className="qi-present-footer mt-5 flex items-center justify-between gap-3 px-6 py-4">
                    <span className="qi-present-muted text-xs tabular-nums">
                        {slideCount} slide{slideCount === 1 ? '' : 's'}
                    </span>
                    <div className="flex gap-2">
                        <button onClick={onCancel} className="qi-dash-button px-3 py-2 text-sm font-medium">Cancel</button>
                        <button
                            onClick={() => selected && onStart(selected.id, onlyReady)}
                            disabled={!selected || slideCount === 0}
                            className="qi-present-start flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Presentation className="h-4 w-4" /> Start presenting
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
