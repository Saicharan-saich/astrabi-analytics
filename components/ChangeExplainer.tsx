import React, { useEffect, useMemo, useState } from 'react';
import { HelpCircle, Loader2, X } from 'lucide-react';
import type { AnalysisResult, Dataset } from '../types';
import { explainChange, periodLabel, periodsOf, shortNumber, type ChangeExplanation, type ExplainRun } from '../services/explainChange';

/**
 * "Why did it change?" under an answer over time: pick a period, and the
 * builder splits the same question every sensible way to find what drove the
 * change from the period before. Worked out from the cleaned rows on this
 * computer; nothing goes to an AI.
 */
export const ChangeExplainer: React.FC<{
    dataset: Dataset;
    config: Record<string, any>;
    result: AnalysisResult;
    run: ExplainRun;
    /** Show this split over time in the builder. */
    onShowSplit: (grouping: string) => void;
}> = ({ dataset, config, result, run, onShowSplit }) => {
    const periods = useMemo(() => periodsOf(result), [result]);
    const [toKey, setToKey] = useState(periods[periods.length - 1]?.key || '');
    const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
    const [answer, setAnswer] = useState<ChangeExplanation | null>(null);
    // A new answer starts closed again.
    useEffect(() => { setState('idle'); setAnswer(null); setToKey(periods[periods.length - 1]?.key || ''); }, [result, periods]);

    const go = async (key = toKey) => {
        setState('working');
        try { setAnswer(await explainChange(dataset, config, result, run, key)); }
        catch { setAnswer(null); }
        setState('done');
    };
    const biggest = answer ? Math.max(...answer.movers.map(m => Math.abs(m.delta)), 1e-9) : 1;

    return (
        <section className="qi-why" aria-label="Why did it change">
            <div className="qi-why-bar">
                <button type="button" className="qi-why-btn" onClick={() => go()} disabled={state === 'working'}>
                    {state === 'working' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <HelpCircle className="h-3.5 w-3.5" aria-hidden />}
                    Why did it change?
                </button>
                <label className="qi-why-period">
                    <span>Into</span>
                    <select value={toKey} aria-label="Period to explain" onChange={e => { setToKey(e.target.value); if (state === 'done') void go(e.target.value); }}>
                        {periods.slice(1).map(p => <option key={p.key} value={p.key}>{periodLabel(p.key)}</option>)}
                    </select>
                    <span>from the period before</span>
                </label>
                {state === 'done' && (
                    <button type="button" className="qi-why-close" aria-label="Hide why it changed" onClick={() => { setState('idle'); setAnswer(null); }}><X className="h-3 w-3" aria-hidden /></button>
                )}
            </div>
            {state === 'done' && (
                <div className="qi-why-panel" role="status" aria-live="polite">
                    {answer ? (
                        <>
                            {answer.sentences.map((s, i) => <p key={i} className={i === 0 ? 'qi-why-lead' : ''}>{s}</p>)}
                            <ul className="qi-why-movers" aria-label={`Change by ${answer.groupingLabel}`}>
                                {answer.movers.map(m => (
                                    <li key={m.key}>
                                        <span className="qi-why-key" title={m.key}>{m.key}</span>
                                        <span className="qi-why-track" aria-hidden>
                                            <span className={`qi-why-fill ${m.delta >= 0 ? 'is-up' : 'is-down'}`} style={{ width: `${Math.max(2, (Math.abs(m.delta) / biggest) * 50)}%` }} />
                                        </span>
                                        <span className={`qi-why-delta ${m.delta >= 0 ? 'is-up' : 'is-down'}`}>{m.delta >= 0 ? '+' : '−'}{shortNumber(Math.abs(m.delta))}</span>
                                    </li>
                                ))}
                            </ul>
                            <div className="qi-why-next">
                                <button type="button" onClick={() => onShowSplit(answer.grouping)}>See it over time by {answer.groupingLabel}</button>
                                {answer.alternatives.map(a => (
                                    <button key={a.grouping} type="button" onClick={() => onShowSplit(a.grouping)}>Also by {a.label}: {a.top.key} {a.top.delta >= 0 ? '+' : '−'}{shortNumber(Math.abs(a.top.delta))}</button>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p>Nothing stands out: from the period before, the change is small or spread evenly across every way of splitting this data.</p>
                    )}
                </div>
            )}
        </section>
    );
};
