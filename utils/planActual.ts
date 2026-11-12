/**
 * A file that sets what happened against a plan: actual spending and budget,
 * sales and target, hours and forecast. Found from how the columns are worked
 * out (variance = budget − actual) or, failing that, from their names. Used so
 * a budget file is summarised by who is over and under, not by trends in the
 * budget itself. Column names only.
 */
import type { ColumnFormula } from './columnFormulas';

export interface PlanActual {
    plan: string;
    actual: string;
    /** spending: more than plan is worse. income: less than plan is worse. unknown: neither is assumed. */
    nature: 'spending' | 'income' | 'unknown';
    /** "budget", "target", "forecast", "plan". */
    planWord: string;
}

const tokens = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const PLAN = /^(budget|budgets|budgeted|plan|planned|target|targets|forecast|forecasted|goal|goals|quota|expected|estimate|estimated|allocation|allocated)$/;
const ACTUAL = /^(actual|actuals|spent|spend|spending|achieved|realised|realized|outturn)$/;
const SPENDING = /^(spent|spend|spending|cost|costs|expense|expenses|expenditure|outgoings|payroll|overspend)$/;
const INCOME = /^(revenue|sales|income|takings|turnover|earned|bookings|orders|units|profit)$/;
const isPlan = (name: string) => tokens(name).some(t => PLAN.test(t));

export function findPlanActual(numberColumns: string[], formulas: ColumnFormula[] = []): PlanActual | null {
    let plan: string | undefined, actual: string | undefined;
    // The file's own difference: variance = budget − actual (either way round).
    for (const f of formulas) {
        if (f.kind !== 'difference' && f.kind !== 'change' && f.kind !== 'change_percent') continue;
        if (isPlan(f.a) !== isPlan(f.b)) { plan = isPlan(f.a) ? f.a : f.b; actual = isPlan(f.a) ? f.b : f.a; break; }
    }
    if (!plan || !actual) {
        const plans = numberColumns.filter(isPlan);
        const actuals = numberColumns.filter(name => !isPlan(name) && tokens(name).some(t => ACTUAL.test(t)));
        if (plans.length !== 1 || actuals.length !== 1) return null;
        [plan, actual] = [plans[0], actuals[0]];
    }
    const words = [...tokens(actual), ...tokens(plan)];
    const nature = words.some(t => SPENDING.test(t)) ? 'spending' : words.some(t => INCOME.test(t)) ? 'income' : /budget/.test(plan.toLowerCase()) ? 'spending' : 'unknown';
    const planWord = /target|goal|quota/i.test(plan) ? 'target' : /forecast|expected|estimat/i.test(plan) ? 'forecast' : /budget|allocat/i.test(plan) ? 'budget' : 'plan';
    return { plan, actual, nature, planWord };
}
