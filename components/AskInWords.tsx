import React, { useState } from 'react';
import { ArrowRight, MessageSquare, X } from 'lucide-react';
import type { Dataset } from '../types';
import { questionFromWords, type WordsQuestion } from '../services/builderFromWords';

/**
 * Type a question; the builder fills itself in and runs. Worked out on this
 * computer from column names and values; nothing goes to an AI.
 */
const SLOT_WORD: Record<string, string> = { measure: 'Show me', split: 'Split', time: 'When', filter: 'Only', top: 'Order', compare: 'Compare' };

export const AskInWords: React.FC<{ dataset: Dataset; asOf?: string; onAsk: (config: Record<string, unknown>) => void; examples?: string[] }> = ({ dataset, asOf, onAsk, examples = [] }) => {
    const [text, setText] = useState('');
    const [last, setLast] = useState<(WordsQuestion & { asked: string }) | null>(null);
    // Examples show while the box is in use, so the builder's controls keep their room.
    const [focused, setFocused] = useState(false);
    const ask = (question = text) => {
        const q = question.trim();
        if (!q) return;
        const parsed = questionFromWords(dataset, q, asOf);
        setLast({ ...parsed, asked: q });
        if (parsed.config.metric) onAsk(parsed.config);
    };
    return (
        <section className="qi-ask" aria-label="Ask in your own words">
            <form className="qi-ask-row" onSubmit={e => { e.preventDefault(); ask(); }}>
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
                <button type="submit" className="qi-ask-go" disabled={!text.trim()} aria-label="Build this question"><ArrowRight className="h-4 w-4" aria-hidden /></button>
            </form>
            {last ? (
                <div className="qi-ask-read" role="status" aria-live="polite">
                    <span className="qi-ask-label">Understood:</span>
                    {last.understood.map((u, i) => (
                        <span key={i} className={`qi-ask-chip is-${u.slot}`}><em>{SLOT_WORD[u.slot]}</em> {u.text}</span>
                    ))}
                    {last.unused.length > 0 && (
                        <span className="qi-ask-unused">Not used: {last.unused.map(w => `“${w}”`).join(', ')}. Pick them in the controls below if you need them.</span>
                    )}
                    <button type="button" className="qi-ask-close" aria-label="Hide what was understood" onClick={() => setLast(null)}><X className="h-3 w-3" aria-hidden /></button>
                </div>
            ) : examples.length > 1 && focused && !text.trim() && (
                <div className="qi-ask-examples" aria-label="Examples">
                    <span>Try:</span>
                    {examples.slice(0, 3).map(example => (
                        // mousedown keeps the box focused, so the click lands before the examples hide
                        <button key={example} type="button" onMouseDown={e => e.preventDefault()} onClick={() => { setText(example); ask(example); }}>{example}</button>
                    ))}
                </div>
            )}
        </section>
    );
};
