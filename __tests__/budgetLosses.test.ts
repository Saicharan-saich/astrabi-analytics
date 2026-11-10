/**
 * "Which department is giving me losses?" on a budget file. The answer once
 * came back the other way round (spending BELOW budget), headed by a
 * comparison of budgets, under a green "Checked". Each part of that is
 * covered here, for any file with actual and budget (or target) figures:
 *   - the cleaner reads Variance and Variance % as measures;
 *   - how a variance is worked out is found on the rows and given to the AI as
 *     a formula (never values), so its sign is not guessed;
 *   - a reading turned around (a saving read as a loss) is caught;
 *   - the headline is about the figure that answers the question.
 */
import { describe, it, expect } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { describeData, planFromResult, buildLeanAnswer } from '../services/ai-sql/leanPipeline';
import { resolveAISQLSemanticModel } from '../services/ai-sql/semanticLayer';
import { findColumnFormulas, describeFormula } from '../utils/columnFormulas';
import { readingTurnedAround } from '../services/ai-sql/readingCheck';
import { ColumnType } from '../types';

let seed = 9;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function budgetFile(way: 'budget-actual' | 'actual-budget') {
    seed = 9;
    const rows: Record<string, any>[] = [];
    for (let m = 0; m < 12; m++) for (const department of ['Operations', 'Marketing', 'Sales', 'HR', 'IT']) for (const category of ['Salaries', 'Software', 'Travel']) {
        const budget = Math.round(5000 + rnd() * 40000);
        const actual = Math.round(budget * (0.8 + rnd() * 0.4) * (department === 'IT' ? 1.15 : 1));
        const variance = way === 'budget-actual' ? budget - actual : actual - budget;
        rows.push({ Month: `2025-${String(m + 1).padStart(2, '0')}-01`, Department: department, Category: category, 'Budgeted Amount': budget, 'Actual Amount': actual, Variance: variance, 'Variance %': Math.round(variance / budget * 10000) / 100 });
    }
    const r = runETLPipeline(rows, 'budget.csv');
    return { id: 'b', name: 'budget.csv', rows: r.rows, columns: r.columns, timeContext: (r as any).timeContext } as any;
}

describe('reading a budget file', () => {
    it('reads Variance and Variance % as measures, never as an ID', () => {
        const ds = budgetFile('budget-actual');
        const type = (name: string) => ds.columns.find((c: any) => c.name === name)?.type;
        expect(type('variance')).toBe(ColumnType.METRIC);
        expect(type('variance_pct')).toBe(ColumnType.METRIC);
        expect(ds.columns.some((c: any) => c.name === 'variance_2')).toBe(false);
        const schema = describeData(ds).schema;
        expect(schema).not.toMatch(/identifier/);
        expect(schema).toMatch(/"variance_pct": NUMBER; measure \(percentage\)/);
    });

    it('tells the AI which way each file works out its variance, from the rows', () => {
        expect(describeData(budgetFile('budget-actual')).schema).toContain('"variance" = "budgeted_amount" − "actual_amount", so "variance" below 0 means "actual_amount" is higher than "budgeted_amount"');
        expect(describeData(budgetFile('actual-budget')).schema).toContain('"variance" = "actual_amount" − "budgeted_amount", so "variance" below 0 means "budgeted_amount" is higher than "actual_amount"');
    });

    it('never calls a variance a refund', () => {
        expect(describeData(budgetFile('budget-actual')).schema).not.toMatch(/refunds, returns or corrections/);
    });
});

describe('formulas between columns', () => {
    it('finds sums, products and percentages, and nothing between unrelated columns', () => {
        const rows = Array.from({ length: 80 }, (_, i) => {
            const qty = 1 + (i % 7), price = 3 + ((i * 7) % 11) + 0.5, cost = price * 0.4 + (i % 3);
            return { qty, price, line_total: qty * price, cost, margin_pct: Math.round((price - cost) / price * 10000) / 100, noise: (i * 37) % 101 + 1 };
        });
        const found = findColumnFormulas(rows, ['qty', 'price', 'line_total', 'cost', 'margin_pct', 'noise']).map(describeFormula);
        expect(found).toContain('"line_total" = "price" × "qty"');
        expect(found.some(f => f.startsWith('"margin_pct" = '))).toBe(true);
        expect(found.some(f => f.includes('"noise"'))).toBe(false);
    });
});

describe('a question read the other way round', () => {
    it('catches a loss question restated as spending below budget', () => {
        const turned = readingTurnedAround('Which department is giving me losses?', 'Which departments have negative total variance, meaning actual spending was below budgeted amount?');
        expect(turned?.read).toMatch(/saving, not a loss/);
        expect(readingTurnedAround('Which departments are over budget?', 'Which departments came in under budget?')).not.toBeNull();
        expect(readingTurnedAround('Where did we miss target?', 'Which regions beat their sales target?')).not.toBeNull();
    });

    it('lets correct readings through', () => {
        expect(readingTurnedAround('Which department is giving me losses?', 'Which departments spent more than their budget, and by how much?')).toBeNull();
        expect(readingTurnedAround('Which department is giving me losses?', 'Which departments have actual spending above the budgeted amount?')).toBeNull();
        expect(readingTurnedAround('Where did we miss target?', 'Which regions had sales below their target?')).toBeNull();
        expect(readingTurnedAround('What were total sales last month?', 'Total sales below budget last month')).toBeNull();
    });
});

describe('the headline answers the question', () => {
    const rows = [
        { department: 'IT', total_budget: 1_200_000, total_actual: 1_390_000, overspend: 190_000 },
        { department: 'Operations', total_budget: 2_920_000, total_actual: 2_950_000, overspend: 30_000 },
        { department: 'Marketing', total_budget: 2_470_000, total_actual: 2_380_000, overspend: -90_000 },
    ];

    it('leads with the measure the AI names as the answer', () => {
        const plan = planFromResult('Which department is giving me losses?', rows, { dimensions: ['department'], measures: ['total_budget', 'total_actual', 'overspend'], answer: 'overspend' });
        expect(plan.metrics[0].field).toBe('overspend');
        // Without the AI naming it, a loss question still leads with the gap.
        expect(planFromResult('Which department is giving me losses?', rows, { dimensions: ['department'], measures: ['total_budget', 'total_actual', 'overspend'] }).metrics[0].field).toBe('overspend');
    });

    it('says which groups are losing money, not that one budget is bigger', () => {
        const ds = budgetFile('budget-actual');
        const result = buildLeanAnswer({
            question: 'Which department is giving me losses?', sql: 'SELECT 1', rows,
            reply: { title: 'Departments over budget', dimensions: ['department'], measures: ['total_budget', 'total_actual', 'overspend'], answer: 'overspend', explanation: 'Actual minus budget for each department.' },
            model: resolveAISQLSemanticModel(ds).model, dataset: ds, started: 0, repairAttempts: 0, tokens: 1, aiModel: 'test', cautions: [],
        });
        const words = `${result.narrative?.headline} ${result.narrative?.summary} ${(result.narrative?.insights || []).join(' ')}`;
        expect(result.narrative?.summary).toBe('2 of 3 have an overspend: IT (190,000) and Operations (30,000). Marketing (-90,000) does not.');
        expect(words).toMatch(/Marketing/);
        expect(words).not.toMatch(/budget is \d|% higher|ahead of/i);
    });
});
