/**
 * The cleaning review: decisions a person makes on each step, held until they
 * press "Apply changes", then turned into the options for one cleaning re-run.
 * The options are stored with the dataset, so the decisions stick.
 */
import type { ETLLog, EtlOptions } from '../types';

export type StepDecision =
    | { kind: 'keep' }
    | { kind: 'undo'; revert: NonNullable<ETLLog['revert']> }
    | { kind: 'outlier'; column: string; choice: 'keep' | 'remove' | 'cap' }
    | { kind: 'typo'; column: string; choice: 'merge' | 'keep' }
    | { kind: 'flag'; key: string; column: string; choice: 'keep' | 'remove' | 'fix'; label: string };

const OUTLIER_WORDS = { keep: 'keep', remove: 'remove', cap: 'cap' } as const;

/** The cleaning options after every decision is applied to the current ones. */
export function buildReviewOptions(current: EtlOptions, decisions: Record<string, StepDecision>): EtlOptions {
    const next: EtlOptions = { ...current };
    const set = (option: keyof EtlOptions, value: unknown) => {
        if (value === null || value === false || value === undefined) delete next[option];
        else (next as any)[option] = value;
    };
    for (const decision of Object.values(decisions)) {
        if (decision.kind === 'undo') {
            const { option, value } = decision.revert;
            // Undoing one column's decision keeps the other columns' decisions.
            if (option === 'customRules') {
                // Undo = delete that rule; other deleted rules stay deleted.
                const kept = new Set(((value as any[]) || []).map(rule => rule.id));
                const removed = ((current.customRules || []).map(rule => rule.id)).filter(id => !kept.has(id));
                const remaining = (next.customRules || []).filter(rule => !removed.includes(rule.id));
                set(option, remaining.length ? remaining : null);
            } else if (option === 'outlierDecisions' || option === 'typoDecisions' || option === 'flagDecisions') {
                const column = Object.keys((current as any)[option] || {}).find(name => !(value && Object.prototype.hasOwnProperty.call(value, name)));
                const remaining = { ...((next as any)[option] || {}) };
                if (column) delete remaining[column];
                set(option, Object.keys(remaining).length ? remaining : null);
            } else {
                set(option, value);
            }
        } else if (decision.kind === 'outlier') {
            next.outlierDecisions = { ...(next.outlierDecisions || {}), [decision.column]: OUTLIER_WORDS[decision.choice] };
        } else if (decision.kind === 'typo') {
            next.typoDecisions = { ...(next.typoDecisions || {}), [decision.column]: decision.choice };
        } else if (decision.kind === 'flag') {
            next.flagDecisions = { ...(next.flagDecisions || {}), [decision.key]: decision.choice };
        }
    }
    return next;
}

const describe = (decision: StepDecision): string | null => {
    switch (decision.kind) {
        case 'undo': return decision.revert.label;
        case 'outlier': return decision.choice === 'keep' ? `Keep unusual '${decision.column}' values as correct`
            : decision.choice === 'remove' ? `Remove rows with unusual '${decision.column}' values`
                : `Cap unusual '${decision.column}' values to the usual range`;
        case 'typo': return decision.choice === 'merge' ? `Merge likely typos in '${decision.column}'` : `Keep similar '${decision.column}' values apart`;
        case 'flag': return `${decision.label} ('${decision.column}')`;
        default: return null;
    }
};

/** What the review will do, for the apply bar. */
export function describeReview(decisions: Record<string, StepDecision>): { changes: number; reviewed: number; summary: string } {
    const all = Object.values(decisions);
    const changes = all.map(describe).filter((text): text is string => Boolean(text));
    return {
        changes: changes.length,
        reviewed: all.filter(decision => decision.kind === 'keep').length,
        summary: changes.slice(0, 3).join(' · ') + (changes.length > 3 ? ` · +${changes.length - 3} more` : ''),
    };
}
