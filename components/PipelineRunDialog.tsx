import React, { useEffect, useState } from 'react';
import { Check, Cloud, Loader2, X, XCircle } from 'lucide-react';
import type { AzurePipeline, PipelineProgress } from '../services/azurePipeline';

export interface PipelineRun { pipeline: AzurePipeline; file: File; controller: AbortController; progress?: PipelineProgress; error?: string }

const STEPS: { stage: PipelineProgress['stage']; label: string }[] = [
    { stage: 'sending', label: 'Sent to your Azure storage' },
    { stage: 'waiting', label: 'Your pipeline cleans it' },
    { stage: 'opening', label: 'Opened here and checked' },
];
const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

/** An upload going through the client's Azure Data Factory pipeline. */
export const PipelineRunDialog: React.FC<{ run: PipelineRun; onUseOriginal: () => void; onClose: () => void }> = ({ run, onUseOriginal, onClose }) => {
    const [, tick] = useState(0);
    useEffect(() => { const t = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(t); }, []);
    const [startedAt] = useState(() => Date.now() - (run.progress?.elapsedMs || 0));
    const current = STEPS.findIndex(s => s.stage === run.progress?.stage);
    return (
        <div className="qi-handover-backdrop" role="presentation">
            <section className="qi-piperun" role="dialog" aria-modal="true" aria-labelledby="qi-piperun-title">
                <header>
                    <Cloud className="h-5 w-5" aria-hidden />
                    <div className="min-w-0">
                        <h2 id="qi-piperun-title">Cleaning {run.file.name} in {run.pipeline.name}’s pipeline</h2>
                        <p>The file goes straight from this browser to your Azure storage and back; it never passes through QuickInsight’s server.</p>
                    </div>
                </header>
                <ol className="qi-piperun-steps">
                    {STEPS.map((step, i) => (
                        <li key={step.stage} className={run.error && i === current ? 'is-error' : i < current ? 'is-done' : i === current ? 'is-now' : ''}>
                            {run.error && i === current ? <XCircle className="h-4 w-4" aria-hidden /> : i < current ? <Check className="h-4 w-4" aria-hidden /> : i === current ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <span className="qi-piperun-dot" aria-hidden />}
                            {step.label}
                        </li>
                    ))}
                </ol>
                {run.error
                    ? <p className="qi-pipe-error" role="alert"><XCircle className="h-3.5 w-3.5" aria-hidden /> {run.error}</p>
                    : <p className="qi-piperun-now" role="status">{run.progress?.message}… <span>{minutes(Date.now() - startedAt)}</span></p>}
                <footer>
                    {run.error ? (
                        <>
                            <button type="button" className="qi-chk-undo" onClick={onUseOriginal}>Use the file as uploaded instead</button>
                            <button type="button" className="qi-review-apply" onClick={onClose}>Close</button>
                        </>
                    ) : (
                        <button type="button" className="qi-chk-undo" onClick={() => run.controller.abort()}><X className="h-3 w-3" aria-hidden /> Stop waiting</button>
                    )}
                </footer>
                {!run.error && run.progress?.stage === 'waiting' && <p className="qi-setup-meta">If you stop waiting, the pipeline still finishes; the file then shows under Cleaned files on Data Source.</p>}
            </section>
        </div>
    );
};
