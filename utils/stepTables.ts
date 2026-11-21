/**
 * stepTables.ts — the other loaded files a combine step needs.
 *
 * Steps run in the cleaning worker, which cannot see the workspace. Only the
 * files that a combine step names are sent (their cleaned rows), and only to
 * the worker in this browser; they are never saved with a setup.
 */
import type { CleaningStep, Dataset } from '../types';
import { findStepTable, type StepTable } from '../services/cleaningSteps';

export const asStepTable = (ds: Dataset): StepTable => ({ name: ds.name, rows: ds.rows, columns: ds.columns });

/** The loaded files (other than the one being cleaned) that these steps combine with. */
export function tablesForSteps(steps: CleaningStep[] | undefined, datasets: Dataset[], exceptId?: string): StepTable[] | undefined {
    const wanted = (steps || []).filter(s => s.kind === 'combine' && !s.off && s.source);
    if (!wanted.length) return undefined;
    const candidates = datasets.filter(d => d.id !== exceptId && Array.isArray(d.rows)).map(asStepTable);
    const picked = new Map<string, StepTable>();
    for (const step of wanted) {
        const t = findStepTable(step.source, candidates);
        if (t) picked.set(t.name, t);
    }
    return picked.size ? [...picked.values()] : undefined;
}
