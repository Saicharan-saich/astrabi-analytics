/**
 * One-click starting points for an empty Question Builder, from the data's
 * shape and column names: the main amount over time, by the groupings owners
 * ask about first, and in total. Each is an ordinary builder question the
 * controls are filled from, so the user sees how it was built.
 */
import type { Dataset } from '../types';
import { describeDatasetShape } from './datasetShape';
import { amountWords, mainAmountAndGroups } from './ai-sql/starterQuestions';
import { spokenName } from '../utils/spokenName';

export interface BuilderStarter { label: string; config: Record<string, unknown> }

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function builderStarters(dataset: Dataset): BuilderStarter[] {
    if (!dataset.rows?.length) return [];
    let shape;
    try { shape = describeDatasetShape(dataset); } catch { return []; }
    const { amount, groups } = mainAmountAndGroups(dataset, shape);
    if (!amount) return [];
    const noun = amountWords(amount);
    const base = { metric: amount, aggregation: 'SUM' };
    const out: BuilderStarter[] = [];
    if (shape.dates.length) out.push({ label: `${capital(noun)} month by month`, config: { ...base, dimension: 'month', sort: 'oldest' } });
    const said = new Set<string>();
    for (const group of groups) {
        const word = spokenName(group);
        if (said.has(word)) continue;
        said.add(word);
        out.push({ label: `${capital(noun)} by ${word}`, config: { ...base, dimension: group, sort: 'desc' } });
        if (said.size === 2) break;
    }
    out.push({ label: `Total ${noun}`, config: { ...base } });
    return out.slice(0, 4);
}
