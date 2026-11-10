/**
 * First questions to offer on an empty AI SQL screen, worded the way an
 * owner or manager would ask them ("What were my total net sales last
 * month?"), built from the data's shape and column names only — never values.
 */
import type { Dataset } from '../../types';
import { describeDatasetShape } from '../datasetShape';
import { buildQuestionExamples } from './scopeIntent';
import { spokenName } from '../../utils/spokenName';

/** The amount people usually mean by "sales" or "money in", most specific first. */
const MAIN_AMOUNT = [/^net_?sales$/, /(^|_)takings$/, /^sales$/, /(^|_)revenue$/, /^total_?sales$/, /^(order_?)?total$/, /^line_?total$/, /(^|_)sales$/, /(^|_)amount$/, /^gross_?sales$/, /^paid_?in$/];
const NOT_MAIN = /(discount|tax|vat|shipping|postage|fee|refund|cost|qty|quantity|units)/i;
/** Groupings owners ask about first. */
const GOOD_GROUP = /(product|item|title|category|type|department|location|store|shop|branch|site|channel|region|city|country|staff|employee|vendor|supplier|service|treatment|clinic|doctor)/i;

export { spokenName };

/** How to talk about the main amount: "net sales" were, "revenue" was, a quantity is units sold. */
function phrase(amountName: string) {
    const said = spokenName(amountName);
    const units = /(^|\s)(qty|quantity|units?)$/.test(said);
    const sales = /(sales|revenue|takings|total|amount|income|paid in|turnover)$/.test(said);
    const noun = units ? 'units sold' : /^(order )?total$|^line total$|^amount$|^sub ?total$/.test(said) ? 'sales' : said;
    const plural = units || /s$/.test(noun);
    return { noun, units, sales: sales || units, was: plural ? 'were' : 'was', has: plural ? 'have' : 'has' };
}

/**
 * The amount an owner means by "sales" and the groupings they ask about first,
 * from the data's shape and column names (shared by AI SQL's first questions
 * and Question Builder's one-click starts).
 */
export function mainAmountAndGroups(dataset: Dataset, shape = describeDatasetShape(dataset)): { amount?: string; groups: string[] } {
    const money = new Set(dataset.columns.filter(c => c.currency).map(c => c.name));
    const amounts = shape.amounts.filter(name => !NOT_MAIN.test(name));
    const ranked = [...amounts].sort((a, b) => {
        const rank = (name: string) => { const i = MAIN_AMOUNT.findIndex(p => p.test(name.toLowerCase())); return i < 0 ? (money.has(name) ? MAIN_AMOUNT.length : MAIN_AMOUNT.length + 1) : i; };
        return rank(a) - rank(b);
    });
    const groups = [...shape.categories.filter(c => GOOD_GROUP.test(c)), ...shape.categories.filter(c => !GOOD_GROUP.test(c))]
        .filter(c => !/(time|status|currency|zone|channel_id)$/i.test(c) || GOOD_GROUP.test(c));
    return { amount: ranked[0] || shape.amounts[0], groups };
}

/** "net sales", "units sold", "sales" — how to say the amount. */
export const amountWords = (name: string) => phrase(name).noun;

export function starterQuestions(dataset: Dataset): string[] {
    if (!dataset.rows?.length) return [];
    let shape;
    try { shape = describeDatasetShape(dataset); } catch { return buildQuestionExamples(dataset); }
    if (shape.countStory) return buildQuestionExamples(dataset);

    const money = new Set(dataset.columns.filter(c => c.currency).map(c => c.name));
    const amounts = shape.amounts.filter(name => !NOT_MAIN.test(name));
    const ranked = (list: string[]) => [...list].sort((a, b) => {
        const rank = (name: string) => { const i = MAIN_AMOUNT.findIndex(p => p.test(name.toLowerCase())); return i < 0 ? (money.has(name) ? MAIN_AMOUNT.length : MAIN_AMOUNT.length + 1) : i; };
        return rank(a) - rank(b);
    });
    const amountName = ranked(amounts)[0] || shape.amounts[0];
    // Order lines with a price and a quantity but no sales column: sales is price × quantity.
    const a = amountName ? (shape.lineSales && /(qty|quantity|units?)$/i.test(amountName) ? phrase('sales') : phrase(amountName)) : null;
    const hasDate = shape.dates.length > 0;
    const groups = [...shape.categories.filter(c => GOOD_GROUP.test(c)), ...shape.categories.filter(c => !GOOD_GROUP.test(c))]
        .filter(c => !/(time|status|currency|zone|channel_id)$/i.test(c) || GOOD_GROUP.test(c));
    const g1 = groups[0] ? spokenName(groups[0]) : null;
    const second = groups.find(g => spokenName(g) !== g1);
    const g2 = second ? spokenName(second) : null;
    const order = shape.lineKey?.word || (shape.rowId && /(order|transaction|receipt|invoice|sale|booking)/i.test(shape.recordWord) ? shape.recordWord : null);
    const orders = order ? (order.endsWith('s') ? order : `${order}s`) : shape.recordsWord;

    const out: string[] = [];
    if (a && hasDate) out.push(a.units ? 'How many units did we sell last month?' : a.sales ? `What ${a.was} my total ${a.noun} last month?` : `What ${a.was} the total ${a.noun} last month?`);
    if (a && g1) out.push(a.units ? `Which ${g1} sells the most units?` : a.sales ? `Which ${g1} brings in the most ${a.noun}?` : `Which ${g1} has the highest ${a.noun}?`);
    if (a && hasDate) out.push(`How ${a.has} ${a.noun} changed month by month?`);
    if (a && order) out.push(a.units ? `How many units are in an average ${order}?` : a.sales ? `What's the average spend per ${order}?` : `What's the average ${a.noun} per ${order}?`);
    else if (a && g2) out.push(`Compare ${a.noun} by ${g2}`);
    if (shape.customerKeys.length) out.push('How many customers came back more than once?');
    if (hasDate && order) out.push(`How many ${orders} did we have last week?`);
    else if (g1 && !a) out.push(`How many ${shape.recordsWord} are there for each ${g1}?`);
    if (out.length < 3) out.push(...buildQuestionExamples(dataset));
    return [...new Set(out)].slice(0, 6);
}
