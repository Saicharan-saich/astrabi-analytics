/**
 * "Give me the column names", "what fields do I have?", "what does each
 * column mean?" — answered here from what the app already knows about the
 * columns (the column dictionary), with no AI call and no query: the list of
 * columns is not a figure worked out from the rows.
 */
import type { Dataset } from '../../types';
import { columnDictionary } from '../columnDictionary';

export { asksForColumns } from './chatContext';

const KIND: Record<string, string> = { 'add up': 'a number that is added up', average: 'a number that is averaged', 'latest value': 'a level on a date (never added up across dates)', count: 'a yes/no answer', 'group by': 'a category to split by', date: 'a date', identifier: 'an ID' };
const plain = (name: string) => name.replace(/_/g, ' ');

/** The columns in words: name, what it holds, and anything still unconfirmed. */
export function columnsAnswer(dataset: Dataset): { message: string; suggestions: string[] } {
    const dictionary = columnDictionary(dataset);
    const lines = dictionary.map(m => {
        const meaning = m.sure && m.meaning ? m.meaning.replace(/\.$/, '') : KIND[m.combine] || 'a column';
        const extra = [
            m.formula ? `worked out as ${m.formula.replace(/"/g, '').replace(/_/g, ' ').split(', so ')[0]}` : '',
            !m.sure ? 'its meaning is not confirmed yet' : '',
        ].filter(Boolean).join('; ');
        return `- ${plain(m.column)}: ${meaning}${extra ? ` (${extra})` : ''}`;
    });
    const hidden = dataset.columns.filter(c => !c.name.startsWith('__')).length - dictionary.length;
    const message = `Your data has ${dictionary.length} column${dictionary.length === 1 ? '' : 's'}${hidden > 0 ? ` (${hidden} more ${hidden === 1 ? 'is' : 'are'} hidden)` : ''}:\n\n${lines.join('\n')}\n\nYou can correct any of these in Dataset Workspace → Columns.`;
    // What happened before what was planned: "actual spending" rather than "budgeted amount".
    const planned = (name: string) => /(budget|plan|target|forecast|quota|expected|estimat)/i.test(name);
    const number = dictionary.find(m => m.combine === 'add up' && !m.formula && !planned(m.column)) || dictionary.find(m => m.combine === 'add up');
    const group = dictionary.find(m => m.combine === 'group by');
    const date = dictionary.find(m => m.combine === 'date');
    const suggestions = [
        number && group ? `Total ${plain(number.column)} by ${plain(group.column)}` : '',
        number && date ? `${plain(number.column).replace(/^./, c => c.toUpperCase())} month by month` : '',
        group ? `How many records for each ${plain(group.column)}?` : '',
    ].filter(Boolean).slice(0, 3);
    return { message, suggestions };
}
