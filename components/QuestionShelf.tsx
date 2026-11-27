import React, { useMemo, useState } from 'react';
import { BookOpen, CheckCircle2, Clock, ListChecks, Save, Trash2, X } from 'lucide-react';
import type { CleaningSetup, Dataset, SavedQuestion } from '../types';
import { useQuestionStore } from '../store/useQuestionStore';
import {
    MAX_PACK, keepableConfig, movingPeriodOf, movingPeriodWords, newQuestionId, questionForToday, questionKey, sortByFit, withSaved,
} from '../utils/savedQuestions';

type Shelf = 'pack' | 'saved' | 'recent';

/**
 * Saved questions, recent questions and the cleaning setup's question pack,
 * one click from the builder. A question that needs a column this data
 * doesn't have is set aside with the reason, not run.
 */
export const QuestionShelf: React.FC<{
    dataset: Dataset;
    asOf?: string;
    /** The question on screen, when there is an answer. */
    current?: { config: Record<string, any>; name: string; chartType?: string };
    onRun: (config: Record<string, any>) => void;
    /** The setup this data was cleaned with, when this browser has it. */
    pack?: CleaningSetup;
    /** Admins can change the setup's pack (not one received from someone else). */
    canEditPack?: boolean;
    onSavePack?: (questions: SavedQuestion[]) => void;
}> = ({ dataset, asOf, current, onRun, pack, canEditPack = false, onSavePack }) => {
    const saved = useQuestionStore(s => s.saved);
    const recentAll = useQuestionStore(s => s.recent);
    const save = useQuestionStore(s => s.save);
    const remove = useQuestionStore(s => s.remove);
    const [open, setOpen] = useState<Shelf | null>(null);
    const [saving, setSaving] = useState(false);
    const [name, setName] = useState('');
    const [moving, setMoving] = useState(true);
    const [toPack, setToPack] = useState(false);
    const [note, setNote] = useState('');

    const columnNames = useMemo(() => dataset.columns.map(c => c.name), [dataset.columns]);
    const recent = useMemo(() => recentAll.filter(q => q.datasetName === dataset.name), [recentAll, dataset.name]);
    const openList: SavedQuestion[] = open === 'pack' ? (pack?.questions || []) : open === 'saved' ? saved : open === 'recent' ? recent : [];
    const fit = useMemo(() => sortByFit(openList, columnNames), [openList, columnNames]);
    const movingNow = current ? movingPeriodOf(current.config, asOf) : null;
    const editablePack = Boolean(pack && canEditPack && !pack.sharedBy && onSavePack);
    const inPack = Boolean(current && pack?.questions?.some(q => questionKey(q.config) === questionKey(current.config)));
    const isSaved = Boolean(current && saved.some(q => questionKey(q.config) === questionKey(current.config)));

    if (!current && !saved.length && !recent.length && !pack?.questions?.length) return null;

    const startSaving = () => {
        if (!current) return;
        setName(current.name);
        setMoving(true);
        setToPack(editablePack && !inPack);
        setNote('');
        setSaving(true);
    };
    const finishSaving = (e: React.FormEvent) => {
        e.preventDefault();
        if (!current || !name.trim()) return;
        const question: SavedQuestion = {
            id: newQuestionId(),
            name: name.trim().slice(0, 160),
            config: keepableConfig(current.config, moving ? movingNow : null),
            createdAt: Date.now(),
            datasetName: dataset.name,
            ...(current.chartType ? { chartType: current.chartType } : {}),
        };
        save(question);
        if (toPack && editablePack && pack) {
            const next = withSaved(pack.questions || [], { ...question, datasetName: undefined }, MAX_PACK);
            onSavePack!(next);
            setNote(`Saved, and added to the question pack for ${pack.name}. It's one click away on every file cleaned with that setup.`);
            setOpen('pack');
        } else {
            setNote('Saved. Find it under My questions.');
            setOpen('saved');
        }
        setSaving(false);
    };
    const run = (q: SavedQuestion) => onRun(questionForToday(q.config, asOf));
    const drop = (shelf: Shelf, q: SavedQuestion) => {
        if (shelf === 'saved') remove(q.id);
        if (shelf === 'pack' && editablePack) onSavePack!((pack!.questions || []).filter(p => p.id !== q.id));
    };

    const tab = (shelf: Shelf, label: string, icon: React.ReactNode, count: number) => (
        <button
            type="button"
            className={`qi-shelf-tab${open === shelf ? ' is-open' : ''}`}
            aria-expanded={open === shelf}
            onClick={() => { setOpen(open === shelf ? null : shelf); setSaving(false); }}
        >
            {icon}<span>{label}</span><span className="qi-shelf-count">{count}</span>
        </button>
    );

    return (
        <section className="qi-shelf" aria-label="Your questions">
            <div className="qi-shelf-bar">
                {current && (
                    <button type="button" className="qi-shelf-save-btn" onClick={startSaving} disabled={saving} title={isSaved ? 'Already saved; save again to rename it' : 'Keep this question to run again'}>
                        {isSaved ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}{isSaved ? 'Saved' : 'Save this question'}
                    </button>
                )}
                {(pack?.questions?.length || editablePack) ? tab('pack', `Question pack · ${pack!.name}`, <ListChecks className="h-3.5 w-3.5" aria-hidden />, pack!.questions?.length || 0) : null}
                {saved.length > 0 && tab('saved', 'My questions', <BookOpen className="h-3.5 w-3.5" aria-hidden />, saved.length)}
                {recent.length > 0 && tab('recent', 'Recent', <Clock className="h-3.5 w-3.5" aria-hidden />, recent.length)}
            </div>

            {saving && current && (
                <form className="qi-shelf-form" onSubmit={finishSaving} aria-label="Save this question">
                    <label className="qi-shelf-field">
                        <span>Name</span>
                        <input value={name} onChange={e => setName(e.target.value)} maxLength={160} autoFocus aria-label="Question name" />
                    </label>
                    {movingNow && (
                        <label className="qi-shelf-check">
                            <input type="checkbox" checked={moving} onChange={e => setMoving(e.target.checked)} />
                            <span>Move with the date: {movingPeriodWords(movingNow)} (otherwise always {current.config.dateFilters?.[0]?.values?.[0]})</span>
                        </label>
                    )}
                    {editablePack && !inPack && (
                        <label className="qi-shelf-check">
                            <input type="checkbox" checked={toPack} onChange={e => setToPack(e.target.checked)} />
                            <span>Add to the question pack for <strong>{pack!.name}</strong>: it runs one click away on every file cleaned with that setup, for everyone it's shared with</span>
                        </label>
                    )}
                    <div className="qi-shelf-actions">
                        <button type="submit" className="qi-shelf-primary" disabled={!name.trim()}>Save</button>
                        <button type="button" className="qi-shelf-secondary" onClick={() => setSaving(false)}>Cancel</button>
                    </div>
                </form>
            )}
            {note && !saving && (
                <p className="qi-shelf-note" role="status">{note}<button type="button" aria-label="Hide" onClick={() => setNote('')}><X className="h-3 w-3" aria-hidden /></button></p>
            )}

            {open && (
                <div className="qi-shelf-panel" role="region" aria-label={open === 'pack' ? 'Question pack' : open === 'saved' ? 'My questions' : 'Recent questions'}>
                    {open === 'pack' && pack && (
                        <p className="qi-shelf-hint">
                            {pack.sharedBy ? `Set up for this data by ${pack.sharedBy}. ` : ''}
                            {fit.ready.length || fit.skipped.length
                                ? 'The questions that matter for this data each time it arrives.'
                                : 'Save a question and tick “Add to the question pack” to build the questions every new file of this kind should answer.'}
                        </p>
                    )}
                    {fit.ready.length > 0 && (
                        <ul className="qi-shelf-list">
                            {fit.ready.map(q => (
                                <li key={q.id}>
                                    <button type="button" className="qi-shelf-item" onClick={() => run(q)}>
                                        <span className="qi-shelf-name">{q.name}</span>
                                        {(q.config._when || (open !== 'pack' && q.datasetName && q.datasetName !== dataset.name)) && (
                                            <span className="qi-shelf-meta">{[movingPeriodWords(q.config._when), open !== 'pack' && q.datasetName !== dataset.name ? q.datasetName : ''].filter(Boolean).join(' · ')}</span>
                                        )}
                                    </button>
                                    {(open === 'saved' || (open === 'pack' && editablePack)) && (
                                        <button type="button" className="qi-shelf-remove" onClick={() => drop(open, q)} aria-label={`Remove “${q.name}”`} title={open === 'pack' ? 'Remove from the pack' : 'Remove'}>
                                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                                        </button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {fit.skipped.length > 0 && (
                        <p className="qi-shelf-skipped">
                            {fit.skipped.length === 1 ? '1 question doesn’t fit' : `${fit.skipped.length} questions don’t fit`} this data: {fit.skipped.slice(0, 3).map(s => `“${s.question.name}” needs ${s.missing.slice(0, 2).join(' and ')}`).join('; ')}{fit.skipped.length > 3 ? '…' : '.'}
                            {open === 'saved' && ' They stay saved for the data they were asked of.'}
                        </p>
                    )}
                </div>
            )}
        </section>
    );
};
