/**
 * Cleaning never changes a total without saying so: after every upload each
 * measure's total is compared with the file, and any difference is explained.
 */
import { describe, expect, it } from 'vitest';
import { runETLPipeline } from '../services/etlPipeline';
import { checkTotals, describeTotals } from '../services/totalsCheck';

const totalsLog = (logs: { step: string }[]) => logs.find(l => l.step === 'Totals Check') as any;

const departments = ['Marketing', 'Sales', 'Operations', 'Finance', 'HR', 'IT', 'Legal', 'Support'];
const budgetFile = () => Array.from({ length: 48 }, (_, i) => ({
    Department: departments[i % departments.length],
    Month: `2025-${String((i % 12) + 1).padStart(2, '0')}-01`,
    'Budget (£)': 1000 + i * 10,
    'Actual (£)': 900 + i * 12,
}));

describe('totals check after cleaning', () => {
    it('says every total matches the file when cleaning changed no numbers', () => {
        const { logs } = runETLPipeline(budgetFile(), 'budget.csv');
        const check = totalsLog(logs);
        expect(check).toBeTruthy();
        expect(check.status).toBe('applied');
        expect(check.details).toMatch(/^Every total matches the file/);
        const actual = check.totalsCheck.find((m: any) => /actual/.test(m.column));
        expect(actual.uploaded).toBeCloseTo(budgetFile().reduce((s, r) => s + r['Actual (£)'], 0));
        expect(actual.cleaned).toBeCloseTo(actual.uploaded);
    });

    it('reads numbers written as text, so the total still matches', () => {
        const file = budgetFile().map((r, i) => (i === 3 ? { ...r, 'Actual (£)': '£1,234.50' } : r));
        const { logs } = runETLPipeline(file, 'budget.csv');
        const check = totalsLog(logs);
        // "£1,234.50" is read as 1234.5, so the total still matches.
        expect(check.status).toBe('applied');
    });

    it('keeps the totals of a CSV budget (text cells, blank actuals)', () => {
        const rows: Record<string, string>[] = [];
        let id = 0;
        for (let m = 0; m < 12; m++) for (const department of ['Marketing', 'Operations', 'IT']) for (const category of ['Payroll', 'Travel', 'Software']) {
            const budgeted = 10000 + m * 100 + (category === 'Payroll' ? 5000 : 0);
            const missing = department === 'Marketing' && category === 'Software' && m < 8;
            const actual = budgeted + (department === 'Marketing' ? 1500 : department === 'Operations' ? 100 : -800);
            rows.push({ 'Record ID': `B${++id}`, Month: `2025-${String(m + 1).padStart(2, '0')}-01`, Department: department, 'Expense Category': category, 'Budgeted Amount': String(budgeted), 'Actual Spending': missing ? '' : String(actual), Variance: missing ? '' : String(budgeted - actual) });
        }
        const { logs } = runETLPipeline(rows, 'department_budget.csv');
        const check = totalsLog(logs);
        expect(check.status).toBe('applied');
        expect(check.details).toMatch(/^Every total matches the file: Budgeted amount 1,319,400, Actual spending 1,253,400, Variance −16,800\.$/);
    });

    it('reports, in money, numbers that were removed or changed', () => {
        const before = [{ a: 10 }, { a: 20 }, { a: 999999 }, { a: 5 }];
        const after = [{ a: 10 }, { a: 25 }, { a: null }, { a: 5 }];
        const check = checkTotals(before, before, after, ['a'], () => 'a');
        expect(check.differences).toHaveLength(1);
        expect(check.differences[0]).toMatchObject({ uploaded: 1000034, cleaned: 40, blanked: { cells: 1, amount: 999999 }, changed: { cells: 1, amount: 5 } });
        const { matches, lines } = describeTotals(check);
        expect(matches).toBe(false);
        expect(lines[0]).toBe('A: the file adds up to 1,000,034, the cleaned data to 40 (−999,994) — 1 number adding up to 999,999 became blank; 1 number was changed (+5 in all).');
    });

    it('explains totals changed by tidying the layout (for example a removed total row)', () => {
        const uploaded = [{ Amount: 10 }, { Amount: 20 }, { Amount: 30 }];
        const tidied = [{ amount: 10 }, { amount: 20 }];
        const check = checkTotals(uploaded, tidied, tidied, ['amount'], () => 'Amount');
        expect(describeTotals(check).lines[0]).toMatch(/^Amount: the file adds up to 60, the cleaned data to 30 \(−30\) — tidying the layout \(total rows, repeated headers, copies\) changed it by −30\./);
    });

    it('works on any measure name, with nothing assumed about the file', () => {
        const rows = [{ 'Kg Harvested': '1.5' }, { 'Kg Harvested': '2,5' }];
        const check = checkTotals(rows, rows, rows, ['Kg Harvested'], c => c);
        expect(check.measures[0].uploaded).toBeGreaterThan(0);
        expect(check.differences).toHaveLength(0);
    });
});
