import React, { useState } from 'react';
import { Flag, X } from 'lucide-react';
import type { AnalysisResult, Dataset } from '../types';
import { budgetColumnFor, secondaryKeyFor, standAgainst, targetFor, type ChartTarget, type StandAgainst } from '../utils/targets';
import { periodLabel, shortNumber } from '../services/explainChange';

const words = (s: string) => s.replace(/_/g, ' ').trim();
const pct = (v: number | null) => (v === null ? '' : ` (${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%)`);
const name = (key: string) => periodLabel(key);

function summary(s: StandAgainst, what: string): string {
    const parts = [`${s.ahead} of ${s.total} at or above ${what}`];
    if (s.worst) parts.push(`furthest behind: ${name(s.worst.key)}${pct(s.worst.pct)}`);
    else if (s.best) parts.push(`furthest ahead: ${name(s.best.key)}${pct(s.best.pct)}`);
    return parts.join(' · ');
}

/**
 * Targets and budgets: type a target to draw it across the chart, or compare
 * with a budget column already in the data; either way, say how each bar or
 * point stands against it.
 */
export const TargetStrip: React.FC<{
    dataset: Dataset;
    config: Record<string, any>;
    result: AnalysisResult;
    target?: ChartTarget;
    onSetTarget: (target: ChartTarget | undefined) => void;
    onCompareBudget: (column: string) => void;
}> = ({ dataset, config, result, target, onSetTarget, onCompareBudget }) => {
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState('');
    const [label, setLabel] = useState('Target');
    const mine = targetFor(target, config);
    const budget = budgetColumnFor(dataset, String(config.metric || ''));
    const budgetShown = budget && (config.secondaryMetrics || []).includes(budget) ? secondaryKeyFor(result, budget) : null;
    const againstTarget = mine ? standAgainst(result, mine.value) : null;
    const againstBudget = budgetShown ? standAgainst(result, budgetShown) : null;

    const open = () => { setValue(mine ? String(mine.value) : ''); setLabel(mine?.label || 'Target'); setEditing(true); };
    const save = (e: React.FormEvent) => {
        e.preventDefault();
        const n = Number(value.replace(/[,\s£$€]/g, ''));
        if (!Number.isFinite(n) || n <= 0) return;
        onSetTarget({ value: n, label: label.trim() || 'Target', metric: String(config.metric) });
        setEditing(false);
    };

    return (
        <section className="qi-target" aria-label="Targets and budgets">
            {editing ? (
                <form className="qi-target-form" onSubmit={save}>
                    <Flag className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <select value={label} onChange={e => setLabel(e.target.value)} aria-label="What to call it">
                        {['Target', 'Budget', 'Plan', 'Goal'].map(o => <option key={o}>{o}</option>)}
                    </select>
                    <span>for {words(String(config.metric))}</span>
                    <input value={value} onChange={e => setValue(e.target.value)} inputMode="decimal" placeholder="e.g. 50000" aria-label="Target value" autoFocus />
                    <button type="submit" className="qi-target-save" disabled={!(Number(value.replace(/[,\s£$€]/g, '')) > 0)}>Draw it</button>
                    <button type="button" className="qi-target-cancel" onClick={() => setEditing(false)}>Cancel</button>
                </form>
            ) : (
                <div className="qi-target-bar">
                    {mine && againstTarget ? (
                        <span className="qi-target-read" role="status">
                            <Flag className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            <span><strong>{mine.label} {shortNumber(mine.value)}:</strong> {summary(againstTarget, `the ${mine.label.toLowerCase()}`)}</span>
                            <button type="button" className="qi-target-link" onClick={open}>Change</button>
                            <button type="button" className="qi-target-x" aria-label={`Remove the ${mine.label.toLowerCase()}`} onClick={() => onSetTarget(undefined)}><X className="h-3 w-3" aria-hidden /></button>
                        </span>
                    ) : (
                        <button type="button" className="qi-target-add" onClick={open}><Flag className="h-3.5 w-3.5" aria-hidden />Add a target</button>
                    )}
                    {budget && !budgetShown && (
                        <button type="button" className="qi-target-add" onClick={() => onCompareBudget(budget)}>Compare with {words(budget)}</button>
                    )}
                    {againstBudget && (
                        <span className="qi-target-read" role="status">Against {words(budget!)}: {summary(againstBudget, words(budget!))}</span>
                    )}
                </div>
            )}
        </section>
    );
};
