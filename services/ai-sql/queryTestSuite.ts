/**
 * AI SQL Query Test Suite — Phase 3.1
 *
 * Canonical question → expected plan pairs for regression testing.
 * Run via: npx ts-node services/ai-sql/queryTestSuite.ts
 * Or import and call runTestSuite() from the browser console.
 */

import { classifyQuestion, ClassificationResult } from './questionClassifier';

// ── Test Case Definition ────────────────────────────────────────

interface TestCase {
    question: string;
    expectedIntent: string;
    expectedGrain?: string;
    expectedSortDir?: 'asc' | 'desc';
    expectedLimit?: number;
    description: string;
}

// ── Test Cases ──────────────────────────────────────────────────

const TEST_CASES: TestCase[] = [
    // ── Trend Queries ──
    {
        question: 'Show monthly sales trend for the last 12 months',
        expectedIntent: 'trend',
        expectedGrain: 'month',
        description: 'Monthly sales trend',
    },
    {
        question: 'How has revenue changed over time?',
        expectedIntent: 'trend',
        description: 'Revenue over time',
    },
    {
        question: 'Daily order trend this week',
        expectedIntent: 'trend',
        expectedGrain: 'day',
        description: 'Daily trend',
    },
    {
        question: 'Quarterly profit trend for 2023',
        expectedIntent: 'trend',
        expectedGrain: 'quarter',
        description: 'Quarterly trend',
    },

    // ── Ranking Queries ──
    {
        question: 'Which region generated the highest revenue?',
        expectedIntent: 'ranking',
        expectedSortDir: 'desc',
        expectedLimit: 1,
        description: 'Highest region',
    },
    {
        question: 'Top 5 products by quantity sold',
        expectedIntent: 'ranking',
        expectedSortDir: 'desc',
        expectedLimit: 5,
        description: 'Top 5 products',
    },
    {
        question: 'Bottom 3 categories by profit',
        expectedIntent: 'ranking',
        expectedSortDir: 'asc',
        expectedLimit: 3,
        description: 'Bottom 3 categories',
    },
    {
        question: 'Which product has the lowest sales?',
        expectedIntent: 'ranking',
        expectedSortDir: 'asc',
        expectedLimit: 1,
        description: 'Lowest sales product',
    },
    {
        question: 'What are the busiest sales days of the week?',
        expectedIntent: 'ranking',
        expectedGrain: 'day_of_week',
        expectedSortDir: 'desc',
        expectedLimit: 7,
        description: 'Busiest days of week',
    },
    {
        question: 'Which month has the highest sales?',
        expectedIntent: 'ranking',
        expectedGrain: 'month_of_year',
        expectedSortDir: 'desc',
        description: 'Busiest month of year',
    },

    // ── Breakdown Queries ──
    {
        question: 'Sales by category',
        expectedIntent: 'breakdown',
        description: 'Sales by category',
    },
    {
        question: 'Revenue by region and segment',
        expectedIntent: 'breakdown',
        description: 'Multi-dimension breakdown',
    },

    // ── Share / Percentage Queries ──
    {
        question: 'What percentage of sales does each category contribute?',
        expectedIntent: 'share_of_total',
        description: 'Category share',
    },
    {
        question: 'Show the proportion of revenue by region',
        expectedIntent: 'share_of_total',
        description: 'Revenue proportion',
    },

    // ── Comparison Queries ──
    {
        question: 'Compare this month vs last month sales',
        expectedIntent: 'comparison',
        description: 'Month comparison',
    },
    {
        question: 'YoY revenue growth',
        expectedIntent: 'comparison',
        description: 'YoY growth',
    },
    {
        question: 'Month over month profit change',
        expectedIntent: 'comparison',
        description: 'MoM change',
    },

    // ── Single Metric Queries ──
    {
        question: 'What is the total revenue?',
        expectedIntent: 'single_metric',
        description: 'Total revenue',
    },
    {
        question: 'How many orders were placed?',
        expectedIntent: 'single_metric',
        description: 'Order count',
    },

    // ── Distribution Queries ──
    {
        question: 'Show the distribution of order values',
        expectedIntent: 'distribution',
        description: 'Order value distribution',
    },
    {
        question: 'What is the frequency of sales amounts?',
        expectedIntent: 'distribution',
        description: 'Sales frequency',
    },

    // ── Day-of-Week Grain ──
    {
        question: 'Sales by day of week',
        expectedIntent: 'ranking',
        expectedGrain: 'day_of_week',
        description: 'Sales by weekday',
    },
    {
        question: 'Which weekday has the most orders?',
        expectedIntent: 'ranking',
        expectedGrain: 'day_of_week',
        expectedSortDir: 'desc',
        description: 'Weekday with most orders',
    },

    // ── Sort Direction ──
    {
        question: 'Which customer spent the least?',
        expectedIntent: 'ranking',
        expectedSortDir: 'asc',
        expectedLimit: 1,
        description: 'Least spending customer',
    },
    {
        question: 'Top 10 customers by revenue',
        expectedIntent: 'ranking',
        expectedSortDir: 'desc',
        expectedLimit: 10,
        description: 'Top 10 customers',
    },
];

// ── Test Runner ─────────────────────────────────────────────────

interface TestResult {
    question: string;
    description: string;
    passed: boolean;
    failures: string[];
    classification: ClassificationResult;
}

export function runTestSuite(): { passed: number; failed: number; total: number; results: TestResult[] } {
    const results: TestResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const tc of TEST_CASES) {
        const classification = classifyQuestion(tc.question);
        const failures: string[] = [];

        // Check intent
        if (classification.intent !== tc.expectedIntent) {
            failures.push(`intent: expected "${tc.expectedIntent}" got "${classification.intent}"`);
        }

        // Check grain (if expected)
        if (tc.expectedGrain && classification.timeGrain !== tc.expectedGrain) {
            failures.push(`grain: expected "${tc.expectedGrain}" got "${classification.timeGrain || 'none'}"`);
        }

        // Check sort direction (if expected)
        if (tc.expectedSortDir && classification.sortDirection !== tc.expectedSortDir) {
            failures.push(`sort: expected "${tc.expectedSortDir}" got "${classification.sortDirection || 'none'}"`);
        }

        // Check limit (if expected)
        if (tc.expectedLimit && classification.limit !== tc.expectedLimit) {
            failures.push(`limit: expected ${tc.expectedLimit} got ${classification.limit || 'none'}`);
        }

        const testPassed = failures.length === 0;
        if (testPassed) passed++;
        else failed++;

        results.push({
            question: tc.question,
            description: tc.description,
            passed: testPassed,
            failures,
            classification,
        });
    }

    // Print results
    console.log('\n══════════════════════════════════════════════════════');
    console.log(`  AI SQL Query Classifier Test Suite`);
    console.log('══════════════════════════════════════════════════════');

    for (const r of results) {
        const icon = r.passed ? '✅' : '❌';
        console.log(`${icon} ${r.description}: "${r.question.substring(0, 50)}..."`);
        if (!r.passed) {
            for (const f of r.failures) {
                console.log(`   ↳ ${f}`);
            }
        }
    }

    console.log('──────────────────────────────────────────────────────');
    console.log(`  ${passed}/${passed + failed} passed  (${Math.round(passed / (passed + failed) * 100)}%)`);
    console.log('══════════════════════════════════════════════════════\n');

    return { passed, failed, total: passed + failed, results };
}

// Export test cases for external use
export { TEST_CASES };
