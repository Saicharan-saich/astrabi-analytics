/**
 * "A few columns need your word": the columns whose meaning is only a guess
 * (an abbreviation like LOS, an internal code like Bucket), each with one
 * plain question. Answers are used for every question from then on and are
 * remembered for the same kind of file. Common columns never appear here.
 */
import { useMemo, useState } from 'react';
import { Check, HelpCircle } from 'lucide-react';
import type { Dataset } from '../types';
import { columnsNeedingWord } from '../services/columnDictionary';

interface Props {
    dataset: Dataset;
    /** Save what the user said a column means (or confirm the guess). */
    onAnswer: (column: string, meaning: string) => void;
}

export function ColumnQuestionsCard({ dataset, onAnswer }: Props) {
    const open = useMemo(() => {
        try { return columnsNeedingWord(dataset); } catch { return []; }
    }, [dataset]);
    const [drafts, setDrafts] = useState<Record<string, string>>({});
    const [later, setLater] = useState(false);
    if (!open.length || later) return null;
    const shown = open.slice(0, 5);
    return (
        <section className="qi-ws-card qi-colq rounded-xl" aria-labelledby="qi-colq-title">
            <header className="qi-colq-head">
                <span className="qi-colq-icon" aria-hidden><HelpCircle className="h-4 w-4" /></span>
                <div>
                    <h2 id="qi-colq-title">{open.length === 1 ? 'One column needs your word' : `${open.length} columns need your word`}</h2>
                    <p>These names could mean different things, so answers won't guess at them. Say what each one means and every answer will use it.</p>
                </div>
            </header>
            <ul className="qi-colq-list">
                {shown.map(m => {
                    const draft = drafts[m.column] ?? '';
                    const save = () => { const text = draft.trim(); if (text) onAnswer(m.column, text); };
                    return (
                        <li key={m.column}>
                            <div className="qi-colq-q">
                                <code>{m.column}</code>
                                <span>{m.question}</span>
                            </div>
                            {m.meaning && <p className="qi-colq-guess">Our guess: {m.meaning}</p>}
                            <div className="qi-colq-answer">
                                <input type="text" value={draft} placeholder="What it means, e.g. length of stay in days"
                                    aria-label={`What ${m.column} means`}
                                    onChange={event => setDrafts(d => ({ ...d, [m.column]: event.target.value }))}
                                    onKeyDown={event => { if (event.key === 'Enter') save(); }} />
                                <button type="button" className="qi-colq-save" disabled={!draft.trim()} onClick={save}>Save</button>
                                {m.meaning && <button type="button" className="qi-colq-right" onClick={() => onAnswer(m.column, m.meaning!)}><Check className="h-3.5 w-3.5" aria-hidden /> The guess is right</button>}
                            </div>
                        </li>
                    );
                })}
            </ul>
            <footer className="qi-colq-foot">
                {open.length > shown.length && <span>{open.length - shown.length} more after these.</span>}
                <button type="button" onClick={() => setLater(true)}>Later</button>
            </footer>
        </section>
    );
}
