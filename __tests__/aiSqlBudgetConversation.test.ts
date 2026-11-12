/**
 * A real chat on a messy department budget workbook went wrong in several
 * ways at once. Each is covered here, for any data:
 *   - an overspend worked out as SUM(actual) − SUM(budget) when some rows have
 *     a budget and no actual set different rows against each other, turning a
 *     department that is over budget into one that looks under;
 *   - "which departments are overspending?" came back with one row, the rest
 *     hidden by a filter;
 *   - "give me column names" ran a query and was "partly checked";
 *   - the overview talked about trends in the budget, not who is over it.
 */
import { describe, it, expect } from 'vitest';
import { unevenBlankPairs, rowWiseDifferences, unevenBlankNote } from '../utils/unevenBlanks';
import { findPlanActual } from '../utils/planActual';
import { oneSidedFilter, withoutSideFilter } from '../services/ai-sql/readingCheck';
import { asksForColumns, classifyTurn } from '../services/ai-sql/chatContext';
import { columnsAnswer } from '../services/ai-sql/columnsAnswer';
import { describeData, buildLeanAnswer, parseLeanReply, LEAN_SYSTEM_PROMPT } from '../services/ai-sql/leanPipeline';
import { resolveAISQLSemanticModel } from '../services/ai-sql/semanticLayer';
import { buildDataStory } from '../services/dataStory';
import { buildDatasetOverview } from '../services/ai-sql/datasetOverview';
import { CHAT_SYSTEM_PROMPT } from '../services/ai-sql/chatReply';
import { ColumnType, type Dataset } from '../types';

const store = new Map<string, string>();
(globalThis as any).localStorage = (globalThis as any).localStorage || { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, String(v)), removeItem: (k: string) => store.delete(k) };

/** Marketing is over budget on every row that has both figures, but 8 of its rows have a budget and no actual yet. */
function budget(): Dataset {
    const rows: Record<string, any>[] = [];
    let id = 0;
    for (let m = 0; m < 12; m++) for (const department of ['Marketing', 'Operations', 'IT']) for (const category of ['Payroll', 'Travel', 'Software']) {
        const budgeted = 10000 + m * 100 + (category === 'Payroll' ? 5000 : 0);
        const missing = department === 'Marketing' && category === 'Software' && m < 8;
        const actual = missing ? null : budgeted + (department === 'Marketing' ? 1500 : department === 'Operations' ? 100 : -800);
        rows.push({ record_id: `B${++id}`, month: `2025-${String(m + 1).padStart(2, '0')}-01`, department, expense_category: category, budgeted_amount: budgeted, actual_spending: actual, variance: actual === null ? null : budgeted - actual });
    }
    return {
        id: 'budget', name: 'department_budget.xlsx', rows, totalRows: rows.length, etlLogs: [], version: 1,
        columns: [
            { name: 'record_id', type: ColumnType.ID }, { name: 'month', type: ColumnType.DATE }, { name: 'department', type: ColumnType.DIMENSION }, { name: 'expense_category', type: ColumnType.DIMENSION },
            { name: 'budgeted_amount', type: ColumnType.METRIC }, { name: 'actual_spending', type: ColumnType.METRIC }, { name: 'variance', type: ColumnType.METRIC },
        ],
    } as unknown as Dataset;
}
const sum = (rows: Record<string, any>[], f: (r: Record<string, any>) => number | null) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);

describe('a difference between two columns when some rows have only one of them', () => {
    const ds = budget();
    const marketing = ds.rows.filter(r => r.department === 'Marketing');

    it('the two ways of working it out disagree, and only row by row matches the file', () => {
        const totals = sum(marketing, r => r.actual_spending) - sum(marketing, r => r.budgeted_amount);
        const rowByRow = sum(marketing, r => r.actual_spending === null ? null : r.actual_spending - r.budgeted_amount);
        expect(rowByRow).toBe(42000);                       // over budget, as the file's variance column says
        expect(-sum(marketing, r => r.variance)).toBe(42000);
        expect(totals).toBeLessThan(0);                     // totals make it look under budget
    });

    it('finds the pair from the rows and counts the rows, nothing else', () => {
        const pairs = unevenBlankPairs(ds.rows, ['budgeted_amount', 'actual_spending', 'variance']);
        expect(pairs).toContainEqual({ a: 'budgeted_amount', b: 'actual_spending', onlyA: 8, onlyB: 0 });
        expect(unevenBlankPairs(ds.rows.filter(r => r.department !== 'Marketing'), ['budgeted_amount', 'actual_spending'])).toEqual([]);
    });

    it('rewrites the query to row by row, only for such pairs, and says so on the answer', () => {
        const pairs = unevenBlankPairs(ds.rows, ['budgeted_amount', 'actual_spending', 'variance']);
        const written = 'SELECT "department", SUM("budgeted_amount") AS total_budget, SUM("actual_spending") - SUM("budgeted_amount") AS overspend FROM "data" GROUP BY 1 ORDER BY SUM("actual_spending") - SUM("budgeted_amount") DESC';
        const { sql, used } = rowWiseDifferences(written, pairs);
        expect(sql).toBe('SELECT "department", SUM("budgeted_amount") AS total_budget, SUM("actual_spending" - "budgeted_amount") AS overspend FROM "data" GROUP BY 1 ORDER BY SUM("actual_spending" - "budgeted_amount") DESC');
        expect(unevenBlankNote(used)).toBe('8 rows have a budgeted amount but no actual spending. Those rows are left out of the difference, so it compares like with like; totals shown beside it still include them, so they may not subtract exactly to it.');
        // No missing figures: the query is left exactly as written.
        expect(rowWiseDifferences(written, [])).toEqual({ sql: written, used: [] });
        // Already row by row: unchanged, and still explained.
        const already = 'SELECT "department", SUM("actual_spending" - "budgeted_amount") AS overspend FROM "data" GROUP BY 1';
        expect(rowWiseDifferences(already, pairs).sql).toBe(already);
        expect(rowWiseDifferences(already, pairs).used).toHaveLength(1);
        // Other subtractions are not touched.
        const other = 'SELECT SUM("budgeted_amount") - 100 AS x, SUM("variance") AS v FROM "data"';
        expect(rowWiseDifferences(other, pairs).sql).toBe(other);
    });

    it('tells the AI, with column names only', () => {
        const { schema } = describeData(ds);
        expect(schema).toMatch(/Some rows have one of .*"budgeted_amount" and "actual_spending".* and not the other/);
        expect(schema).toMatch(/row by row/);
        expect(schema).not.toMatch(/42000|42,000|\b8 rows\b/);
    });
});

describe('"which departments are overspending?" shows every department', () => {
    const q = 'Which departments are overspending?';
    it('catches a query that keeps only one side of zero', () => {
        expect(oneSidedFilter('SELECT "department", SUM("actual_spending" - "budgeted_amount") AS overspend FROM "data" GROUP BY 1 HAVING SUM("actual_spending" - "budgeted_amount") > 0 ORDER BY 2 DESC', q)).toBe(true);
        expect(oneSidedFilter('WITH t AS (SELECT "department", SUM("variance") AS total_variance FROM "data" GROUP BY 1) SELECT * FROM t WHERE total_variance < 0', q)).toBe(true);
        expect(oneSidedFilter('SELECT "department", SUM("actual_spending" - "budgeted_amount") AS overspend FROM "data" GROUP BY 1 ORDER BY 2 DESC', q)).toBe(false);
    });
    it('takes a side-only HAVING off the query the live AI actually wrote, and keeps real thresholds', () => {
        // Written by the live AI for this question on 12 Nov 2026: only Marketing and Operations came back.
        const live = 'SELECT\n  "department",\n  ROUND(SUM("actual_spending") - SUM("budgeted_amount"), 2) AS overspend,\n  ROUND(SUM("budgeted_amount"), 2) AS total_budgeted_amount,\n  COUNT(*) AS group_size\nFROM "data"\nGROUP BY "department"\nHAVING SUM("actual_spending") > SUM("budgeted_amount")\nORDER BY overspend DESC\nLIMIT 10;';
        const all = withoutSideFilter(live, q)!;
        expect(all).not.toMatch(/HAVING/i);
        expect(all).toMatch(/GROUP BY "department"\s+ORDER BY overspend DESC\s+LIMIT 10$/);
        expect(withoutSideFilter('SELECT "d", SUM("v") AS v FROM "data" GROUP BY 1 HAVING SUM("v") < 0', q)).toBe('SELECT "d", SUM("v") AS v FROM "data" GROUP BY 1');
        // A figure someone chose, a text filter, a count question and an "only" question keep their HAVING.
        expect(withoutSideFilter('SELECT "d", SUM("v") AS v FROM "data" GROUP BY 1 HAVING COUNT(*) >= 5', q)).toBeNull();
        expect(withoutSideFilter('SELECT "d", SUM("v") AS v FROM "data" GROUP BY 1 HAVING SUM("v") > 10000', q)).toBeNull();
        expect(withoutSideFilter(live, 'How many departments are overspending?')).toBeNull();
        expect(withoutSideFilter(live, 'Show only the departments that are overspending')).toBeNull();
        expect(withoutSideFilter(live, 'Which departments overspent by more than 5000?')).toBeNull();
        // A HAVING inside a sub-query is not the answer's own filter.
        expect(withoutSideFilter('SELECT COUNT(*) AS n FROM (SELECT "d" FROM "data" GROUP BY 1 HAVING SUM("v") > 0)', q)).toBeNull();
    });
    it('leaves alone a count, an "only", a threshold that is not zero and a filter on rows', () => {
        const having = 'SELECT "department", SUM("variance") AS v FROM "data" GROUP BY 1 HAVING SUM("variance") < 0';
        expect(oneSidedFilter(having, 'How many departments are overspending?')).toBe(false);
        expect(oneSidedFilter(having, 'Show only the departments that are overspending')).toBe(false);
        expect(oneSidedFilter('SELECT "department", SUM("variance") AS v FROM "data" GROUP BY 1 HAVING SUM("budgeted_amount") > 50000', q)).toBe(false);
        expect(oneSidedFilter('SELECT "department", SUM("variance") AS v FROM "data" WHERE "variance" < 0.5 GROUP BY 1', q)).toBe(false);
        expect(oneSidedFilter('SELECT "department", COUNT(*) AS n FROM "data" WHERE "actual_spending" > 0 GROUP BY 1', q)).toBe(false);
    });
    it('a single group that is barely over is said plainly, not as "100% of the total shown"', () => {
        const ds = budget();
        const result = buildLeanAnswer({
            question: q, sql: 'SELECT 1', rows: [{ department: 'Operations', total_budgeted_amount: 2_920_000, overspend: 3_814 }],
            reply: { dimensions: ['department'], measures: ['total_budgeted_amount', 'overspend'], answer: 'overspend' },
            model: resolveAISQLSemanticModel(ds).model, dataset: ds, started: 0, repairAttempts: 0, tokens: 1, aiModel: 'test', cautions: [],
        });
        expect(result.narrative?.summary).toBe('Operations is 3,814 over budget (0.1% of its budget). That is within 2% of budget.');
        expect(result.narrative?.summary).not.toMatch(/of the total shown/);
    });
});

describe('"give me column names" is answered from what the app knows, with no AI and no query', () => {
    it.each(['give me column names', 'Give me the column names please'.replace(' please', ''), 'what are the columns?', 'list all the fields', 'show me the headers', 'what columns do I have', 'columns', 'what are the column names in my data?', 'What does each column mean?'])('"%s" asks for the columns', message => {
        expect(asksForColumns(message)).toBe(true);
        expect(classifyTurn(message, true, budget()).kind).toBe('summary');
    });
    it.each(['which columns have the highest spending?', 'total actual spending by department', 'what is the average budgeted amount per department?', 'give me spending by department', 'show me the top departments', 'which department is overspending?'])('"%s" is a data question', message => {
        expect(asksForColumns(message)).toBe(false);
    });
    it('lists every column in plain words, with how a worked-out column is made', () => {
        const { message, suggestions } = columnsAnswer(budget());
        expect(message).toMatch(/^Your data has 7 columns:/);
        expect(message).toMatch(/- department: a category to split by/);
        expect(message).toMatch(/- actual spending: a number that is added up/);
        expect(message).toMatch(/- variance: .*worked out as variance = budgeted amount − actual spending/);
        expect(suggestions[0]).toBe('Total actual spending by department');
        expect(message).not.toMatch(/_/);
        expect(suggestions.length).toBeGreaterThan(0);
    });
});

describe('a budget file is summarised by who is over and under, not by trends in the budget', () => {
    it('finds the plan and the actual from how the variance is worked out, or from the names', () => {
        expect(findPlanActual(['budgeted_amount', 'actual_spending', 'variance'], [{ result: 'variance', kind: 'difference', a: 'budgeted_amount', b: 'actual_spending', rows: 100 }]))
            .toEqual({ plan: 'budgeted_amount', actual: 'actual_spending', nature: 'spending', planWord: 'budget' });
        expect(findPlanActual(['sales_target', 'actual_sales'], [])).toEqual({ plan: 'sales_target', actual: 'actual_sales', nature: 'income', planWord: 'target' });
        expect(findPlanActual(['revenue', 'cost', 'profit'], [{ result: 'profit', kind: 'difference', a: 'revenue', b: 'cost', rows: 100 }])).toBeNull();
        expect(findPlanActual(['quantity', 'price'], [])).toBeNull();
    });
    it('leads with spending against budget, row by row, and names who is furthest over', () => {
        const ds = budget();
        const story = buildDataStory(ds);
        const plan = story.findings.find(f => f.id === 'plan')!;
        expect(plan.headline).toMatch(/^Spent .* against a budget of .*: .* over \(/);
        expect(plan.points.join(' ')).toMatch(/2 of 3 departments are over budget\. Furthest: Marketing \(42\.0K over, 11\.8% of budget\), Operations/);
        expect(plan.points.join(' ')).toMatch(/Furthest under budget: IT/);
        expect(plan.points.join(' ')).toMatch(/8 rows are missing the budgeted amount or the actual spending, and are left out of this comparison\./);
        // The overview's measure is what was spent, not what was planned.
        expect(story.findings[0].headline).toMatch(/actual spending/);
        const overview = buildDatasetOverview(ds);
        expect(overview.insights[0]).toMatch(/^Spent .* against a budget/);
    });
    it('data with no plan gets no such finding', () => {
        const ds = budget();
        const plain = { ...ds, rows: ds.rows.map(({ budgeted_amount, variance, ...row }) => row), columns: ds.columns.filter(c => !['budgeted_amount', 'variance'].includes(c.name)) } as Dataset;
        expect(buildDataStory(plain).findings.find(f => f.id === 'plan')).toBeUndefined();
    });
});

describe('what the AI is told', () => {
    it('answers the everyday reading and offers the others, instead of stopping to ask', () => {
        expect(LEAN_SYSTEM_PROMPT).toMatch(/"spending the most" is the largest actual spending/);
        expect(LEAN_SYSTEM_PROMPT).toMatch(/"alternatives"/);
        const reply = parseLeanReply(JSON.stringify({ action: 'answer', sql: 'SELECT 1', question: 'Which expense category has the most actual spending?', alternatives: ['Which expense_category has the largest budget?', 'Which expense category is most over budget?', '', 'a', 'b'] }));
        expect(reply.action === 'answer' && reply.alternatives).toEqual(['Which expense category has the largest budget?', 'Which expense category is most over budget?', 'a']);
    });
    it('never agrees or disagrees about figures it has not seen', () => {
        expect(LEAN_SYSTEM_PROMPT).toMatch(/Never say they are right or wrong/);
        expect(CHAT_SYSTEM_PROMPT).toMatch(/never say "you're right"/);
        expect(CHAT_SYSTEM_PROMPT).toMatch(/EVERY group/);
    });
});
