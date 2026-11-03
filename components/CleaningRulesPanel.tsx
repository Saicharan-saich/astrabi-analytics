import React, { useMemo, useState } from 'react';
import { Loader2, Plus, Ruler, Trash2 } from 'lucide-react';
import { ColumnType, type CleaningRule, type Dataset, type EtlOptions } from '../types';
import { describeRule } from '../services/etlQualityChecks';

type Test = CleaningRule['test'];

const TESTS: { test: Test; label: string; needs?: 'number' | 'list' | 'pattern'; for: ('number' | 'text' | 'date')[] }[] = [
    { test: 'min', label: 'is at least', needs: 'number', for: ['number'] },
    { test: 'max', label: 'is at most', needs: 'number', for: ['number'] },
    { test: 'one_of', label: 'is one of (comma-separated)', needs: 'list', for: ['text'] },
    { test: 'matches', label: 'matches the pattern', needs: 'pattern', for: ['text'] },
    { test: 'not_future', label: 'is not in the future', for: ['date'] },
    { test: 'not_blank', label: 'is never blank', for: ['number', 'text', 'date'] },
    { test: 'unique', label: 'has no repeated values', for: ['number', 'text', 'date'] },
];

const kindOf = (type: ColumnType): 'number' | 'text' | 'date' =>
    type === ColumnType.METRIC ? 'number' : type === ColumnType.DATE ? 'date' : 'text';

/**
 * The analyst's own checks. A problem found once becomes a rule, and the rule
 * is applied every time the data is cleaned — how a new, rare kind of problem
 * is caught from then on without anyone writing code.
 */
export const CleaningRulesPanel: React.FC<{
    dataset: Dataset;
    onApply?: (nextOptions: EtlOptions, label: string) => void;
    busy?: boolean;
}> = ({ dataset, onApply, busy = false }) => {
    const rules = dataset.etlOptions?.customRules || [];
    const columns = dataset.columns.filter(column => !column.name.startsWith('__'));
    const [column, setColumn] = useState(columns[0]?.name || '');
    const columnKind = kindOf(columns.find(c => c.name === column)?.type || ColumnType.DIMENSION);
    const tests = TESTS.filter(t => t.for.includes(columnKind));
    const [test, setTest] = useState<Test>(tests[0]?.test || 'not_blank');
    const activeTest = tests.find(t => t.test === test) || tests[0];
    const [value, setValue] = useState('');
    const [action, setAction] = useState<CleaningRule['action']>('flag');
    const [open, setOpen] = useState(false);

    // What each rule found on the last clean-up, from the cleaning log.
    const outcome = useMemo(() => {
        const map = new Map<string, string>();
        for (const rule of rules) {
            const words = describeRule(rule);
            const log = (dataset.etlLogs || []).find(l => l.details.includes(`"${words}"`));
            if (!log) continue;
            map.set(rule.id, log.step === 'Rule Passed' ? 'Every row passes'
                : log.step === 'Rule Applied' ? `Removed ${Math.max(0, (log.rowsBefore ?? 0) - (log.rowsAfter ?? 0)).toLocaleString()} row(s)`
                    : log.step === 'Rule Skipped' ? 'Column not in this data'
                        : `${(log.affectedRows ?? 0).toLocaleString()} row(s) to review`);
        }
        return map;
    }, [rules, dataset.etlLogs]);

    if (!onApply) return null;
    const options = dataset.etlOptions || {};
    const needsValue = Boolean(activeTest?.needs);
    const valueOk = !needsValue || (activeTest?.needs === 'number' ? value.trim() !== '' && Number.isFinite(Number(value)) : value.trim() !== '');

    const add = () => {
        if (!column || !activeTest || !valueOk) return;
        const rule: CleaningRule = { id: `r${Date.now().toString(36)}`, column, test: activeTest.test, value: needsValue ? value.trim() : undefined, action };
        onApply({ ...options, customRules: [...rules, rule] }, `Rule added: ${describeRule(rule)}`);
        setValue('');
        setOpen(false);
    };
    const remove = (rule: CleaningRule) => {
        const rest = rules.filter(r => r.id !== rule.id);
        onApply({ ...options, customRules: rest.length ? rest : undefined }, `Rule deleted: ${describeRule(rule)}`);
    };

    return (
        <section className="qi-rules qi-ws-card rounded-xl" aria-label="Your cleaning rules">
            <div className="qi-rules-head">
                <div className="min-w-0">
                    <h3><Ruler className="h-4 w-4" aria-hidden /> Your rules</h3>
                    <p>Found a problem the checks missed? Write it down once as a rule, and it is checked every time this data is cleaned.</p>
                </div>
                {!open && (
                    <button type="button" className="qi-rules-add" onClick={() => setOpen(true)} disabled={busy}>
                        <Plus className="h-4 w-4" aria-hidden /> Add a rule
                    </button>
                )}
            </div>

            {rules.length > 0 && (
                <ul className="qi-rules-list">
                    {rules.map(rule => (
                        <li key={rule.id}>
                            <span className="qi-rules-words">{describeRule(rule)}</span>
                            <span className="qi-rules-action">{rule.action === 'remove' ? 'Remove rows that break it' : 'Flag for review'}</span>
                            {outcome.get(rule.id) && <span className="qi-rules-outcome">{outcome.get(rule.id)}</span>}
                            <button type="button" className="qi-rules-delete" onClick={() => remove(rule)} disabled={busy} aria-label={`Delete rule: ${describeRule(rule)}`}>
                                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {open && (
                <form className="qi-rules-form" onSubmit={event => { event.preventDefault(); add(); }}>
                    <label>
                        <span>Column</span>
                        <select value={column} onChange={event => {
                            setColumn(event.target.value);
                            const kind = kindOf(columns.find(c => c.name === event.target.value)?.type || ColumnType.DIMENSION);
                            setTest(TESTS.find(t => t.for.includes(kind))?.test || 'not_blank');
                            setValue('');
                        }}>
                            {columns.map(c => <option key={c.name} value={c.name}>{c.name.replace(/_/g, ' ')}</option>)}
                        </select>
                    </label>
                    <label>
                        <span>Must</span>
                        <select value={activeTest?.test} onChange={event => { setTest(event.target.value as Test); setValue(''); }}>
                            {tests.map(t => <option key={t.test} value={t.test}>{t.label}</option>)}
                        </select>
                    </label>
                    {needsValue && (
                        <label>
                            <span>{activeTest?.needs === 'number' ? 'Value' : activeTest?.needs === 'list' ? 'Allowed values' : 'Pattern'}</span>
                            <input
                                value={value}
                                onChange={event => setValue(event.target.value)}
                                inputMode={activeTest?.needs === 'number' ? 'decimal' : undefined}
                                placeholder={activeTest?.needs === 'number' ? '0' : activeTest?.needs === 'list' ? 'Petrol, Diesel, Hybrid' : '^[A-Z]{2}-\\d{4}$'}
                                aria-label="Rule value"
                            />
                        </label>
                    )}
                    <label>
                        <span>When a row breaks it</span>
                        <select value={action} onChange={event => setAction(event.target.value as CleaningRule['action'])}>
                            <option value="flag">Flag it for my review</option>
                            <option value="remove">Remove it every time</option>
                        </select>
                    </label>
                    <div className="qi-rules-form-actions">
                        <button type="button" className="qi-ws-ghost px-3 py-1.5 rounded-lg text-[13px] font-semibold" onClick={() => setOpen(false)}>Cancel</button>
                        <button type="submit" className="qi-review-apply" disabled={!valueOk || busy}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />} Add and re-clean
                        </button>
                    </div>
                </form>
            )}
        </section>
    );
};
