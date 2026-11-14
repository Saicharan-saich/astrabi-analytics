/**
 * When QuickInsight may state an accuracy figure in public, and what it says.
 *
 * Rule: the latest `consecutiveRuns` full live runs (at least
 * `minimumQuestions` questions each) must all reach `threshold`. The figure
 * shown is the lowest of those runs, rounded down, so it never overstates.
 * Runs are recorded in accuracyClaim.json.
 */
import record from './accuracyClaim.json';

export interface AccuracyRun { date: string; suite: string; passed: number; total: number; note?: string }
export interface AccuracyRecord { threshold: number; consecutiveRuns: number; minimumQuestions: number; runs: AccuracyRun[] }

export function accuracyClaimFrom(data: AccuracyRecord): string | null {
    const latest = data.runs.slice(-data.consecutiveRuns);
    if (latest.length < data.consecutiveRuns) return null;
    if (latest.some(run => run.total < data.minimumQuestions || run.passed > run.total)) return null;
    const rates = latest.map(run => run.passed / run.total);
    if (rates.some(rate => rate < data.threshold)) return null;
    const lowest = Math.floor(Math.min(...rates) * 1000) / 10;
    const questions = Math.min(...latest.map(run => run.total));
    return `In our last ${latest.length} test runs of ${questions} real business questions, at least ${lowest}% were answered correctly.`;
}

/** The public claim right now, or null (no claim is made). */
export const publicAccuracyClaim: string | null = accuracyClaimFrom(record as AccuracyRecord);
