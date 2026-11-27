import React, { useRef, useState } from 'react';
import { ArrowRight, Loader2, MessageSquare, Sparkles, X } from 'lucide-react';
import type { Dataset } from '../types';
import { planFromQuestion, type BuilderAnswerPlan } from '../services/builderAI';
import type { TableCalculation } from '../utils/tableCalculations';

/**
 * Type a question; the AI sets up the builder across Build, Time, Compare and
 * Calc, and it runs. The AI gets the question and the file's column names and
 * kinds, never rows. Filter words are matched to the file's values here. If
 * the AI can't be reached, the question is read on this computer instead.
 */
const SLOT_WORD: Record<string, string> = { measure: 'Show me', split: 'Split', time: 'When', filter: 'Only', top: 'Order', compare: 'Compare', calc: 'Calc' };

export const AskInWords: React.FC<{
    dataset: Dataset;
    asOf?: string;
    onAsk: (config: Record<string, unknown>, calculation: TableCalculation | null) => void;
    examples?: string[];
    /** For tests: how the plan is made. */
    plan?: typeof planFromQuestion;
}> = ({ dataset, asOf, onAsk, examples = [], plan = planFromQuestion }) => {
    const [text, setText] = useState('');
    const [last, setLast] = useState<(BuilderAnswerPlan & { asked: string }) | null>(null);
    const [busy, setBusy] = useState(false);
    // Examples show while the box is in use, so the builder's controls keep their room.
    const [focused, setFocused] = useState(false);
    const askSeq = useRef(0);
    const ask = async (question = text) => {
        const q = question.trim();
        if (!q || busy) return;
        const seq = ++askSeq.current;
        setBusy(true);
        setLast(null);
        try {
            const result = await plan(dataset, q, asOf);
            if (seq !== askSeq.current) return;
            setLast({ ...result, asked: q });
            if (result.config.metric) onAsk(result.config, result.calculation);
        } finally {
            if (seq === askSeq.current) setBusy(false);
        }
    };
    return (
        <section className="qi-ask" aria-label="Ask in your own words">
            <form className="qi-ask-row" onSubmit={e => { e.preventDefault(); void ask(); }}>
                <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />
                <input
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder={examples[0] ? `Ask in your own words, e.g. ${examples[0]}` : 'Ask in your own words, e.g. sales by month last year'}
                    aria-label="Ask in your own words"
                    autoComplete="off"
                    spellCheck
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                />
                <button type="submit" className="qi-ask-go" disabled={!text.trim() || busy} aria-label="Build this question">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowRight className="h-4 w-4" aria-hidden />}
                </button>
            </form>
            {busy ? (
                <div className="qi-ask-read" role="status" aria-live="polite"><Sparkles className="h-3.5 w-3.5" aria-hidden /> Setting up the builder for your question…</div>
            ) : last ? (
                <div className="qi-ask-read" role="status" aria-live="polite">
                    <span className="qi-ask-label">{last.source === 'ai' ? 'Set up:' : 'Understood:'}</span>
                    {last.understood.map((u, i) => (
                        <span key={i} className={`qi-ask-chip is-${u.slot}`}><em>{SLOT_WORD[u.slot]}</em> {u.text}</span>
                    ))}
                    {last.notes.length > 0 && (
                        <span className="qi-ask-unused">{last.notes.join(' ')} {last.source === 'local' ? 'Pick them in the controls below if you need them.' : ''}</span>
                    )}
                    {last.source === 'local' && last.fallbackReason && (
                        <span className="qi-ask-source" title={last.fallbackReason}>The AI wasn't available, so this was read on this computer.</span>
                    )}
                    {!last.config.metric && <span className="qi-ask-unused">Couldn't find a measure to show. Try naming a column, e.g. “sales by month”.</span>}
                    <button type="button" className="qi-ask-close" aria-label="Hide what was understood" onClick={() => setLast(null)}><X className="h-3 w-3" aria-hidden /></button>
                </div>
            ) : examples.length > 1 && focused && !text.trim() && (
                <div className="qi-ask-examples" aria-label="Examples">
                    <span>Try:</span>
                    {examples.slice(0, 3).map(example => (
                        // mousedown keeps the box focused, so the click lands before the examples hide
                        <button key={example} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setText(example); void ask(example); }}>{example}</button>
                    ))}
                </div>
            )}
        </section>
    );
};
