/**
 * analyticsTests.ts — Deterministic Analytics Test Framework
 *
 * REQUIREMENTS:
 *   - Test datasets with known expected results
 *   - Cover: SUM, AVG, COUNT_DISTINCT correctness
 *   - Cover: join correctness (fan-out detection)
 *   - Cover: time intelligence
 *   - Every test is deterministic and reproducible
 *
 * USAGE:
 *   Import and call `runAllTests()` during development or CI.
 *   Results are logged to console.
 */

import { AggregationType } from '../types';
import { computeAggregation, countDistinct, executeAggregation, filterRows, groupBy } from './nativeAggregator';
import { classifyMetric } from './metricRegistry';
import { detectCardinality, validateJoin } from './joinValidator';

// ═══════════════════════════════════════════════════════════════════
// TEST INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════════

interface TestCase {
    name: string;
    fn: () => void;
}

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

function assertEqual(actual: any, expected: any, message: string): void {
    const actualStr = JSON.stringify(actual);
    const expectedStr = JSON.stringify(expected);
    if (actualStr !== expectedStr) {
        throw new Error(`${message}\n  Expected: ${expectedStr}\n  Actual:   ${actualStr}`);
    }
}

function assertClose(actual: number, expected: number, tolerance: number, message: string): void {
    if (Math.abs(actual - expected) > tolerance) {
        throw new Error(`${message}\n  Expected: ${expected} (±${tolerance})\n  Actual:   ${actual}`);
    }
}

function assertThrows(fn: () => void, message: string): void {
    try {
        fn();
        throw new Error(`${message}\n  Expected function to throw, but it did not.`);
    } catch (e: any) {
        if (e.message.startsWith(message)) throw e; // Re-throw our own assertion errors
        // Function threw as expected — pass
    }
}

// ═══════════════════════════════════════════════════════════════════
// TEST DATA
// ═══════════════════════════════════════════════════════════════════

const SAMPLE_SALES = [
    { order_id: '001', product: 'Laptop', region: 'North', revenue: 1200, quantity: 1, price: 1200, discount: 100, order_date: '2024-01-15' },
    { order_id: '002', product: 'Phone', region: 'North', revenue: 800, quantity: 2, price: 400, discount: 0, order_date: '2024-01-20' },
    { order_id: '003', product: 'Laptop', region: 'South', revenue: 2400, quantity: 2, price: 1200, discount: 200, order_date: '2024-02-10' },
    { order_id: '004', product: 'Tablet', region: 'South', revenue: 500, quantity: 1, price: 500, discount: 50, order_date: '2024-02-15' },
    { order_id: '005', product: 'Phone', region: 'East', revenue: 400, quantity: 1, price: 400, discount: 0, order_date: '2024-03-01' },
    { order_id: '006', product: 'Laptop', region: 'West', revenue: 1200, quantity: 1, price: 1200, discount: 0, order_date: '2024-03-10' },
    { order_id: '007', product: 'Tablet', region: 'North', revenue: 1000, quantity: 2, price: 500, discount: 100, order_date: '2024-03-20' },
    { order_id: '008', product: 'Phone', region: 'East', revenue: 1600, quantity: 4, price: 400, discount: 50, order_date: '2024-04-05' },
];

// ═══════════════════════════════════════════════════════════════════
// AGGREGATION TESTS
// ═══════════════════════════════════════════════════════════════════

const AGGREGATION_TESTS: TestCase[] = [
    {
        name: 'SUM revenue = 9100',
        fn: () => {
            const result = computeAggregation(SAMPLE_SALES.map(r => r.revenue), AggregationType.SUM);
            assertEqual(result, 9100, 'SUM(revenue) should be 9100');
        },
    },
    {
        name: 'AVG price = 725',
        fn: () => {
            const result = computeAggregation(SAMPLE_SALES.map(r => r.price), AggregationType.AVG);
            assertEqual(result, 725, 'AVG(price) should be 725');
        },
    },
    {
        name: 'COUNT quantity = 8',
        fn: () => {
            const result = computeAggregation(SAMPLE_SALES.map(r => r.quantity), AggregationType.COUNT);
            assertEqual(result, 8, 'COUNT(quantity) should be 8');
        },
    },
    {
        name: 'COUNT_DISTINCT product = 3',
        fn: () => {
            const result = countDistinct(SAMPLE_SALES.map(r => r.product));
            assertEqual(result, 3, 'COUNT_DISTINCT(product) should be 3');
        },
    },
    {
        name: 'MIN revenue = 400',
        fn: () => {
            const result = computeAggregation(SAMPLE_SALES.map(r => r.revenue), AggregationType.MIN);
            assertEqual(result, 400, 'MIN(revenue) should be 400');
        },
    },
    {
        name: 'MAX revenue = 2400',
        fn: () => {
            const result = computeAggregation(SAMPLE_SALES.map(r => r.revenue), AggregationType.MAX);
            assertEqual(result, 2400, 'MAX(revenue) should be 2400');
        },
    },
    {
        name: 'SUM quantity = 14',
        fn: () => {
            const result = computeAggregation(SAMPLE_SALES.map(r => r.quantity), AggregationType.SUM);
            assertEqual(result, 14, 'SUM(quantity) should be 14');
        },
    },
    {
        name: 'Empty array returns 0',
        fn: () => {
            const result = computeAggregation([], AggregationType.SUM);
            assertEqual(result, 0, 'SUM([]) should be 0');
        },
    },
    {
        name: 'NaN/null values are filtered',
        fn: () => {
            const result = computeAggregation([100, NaN, null as any, 200, undefined as any], AggregationType.SUM);
            assertEqual(result, 300, 'SUM with NaN/null should be 300');
        },
    },
];

// ═══════════════════════════════════════════════════════════════════
// GROUP BY + AGGREGATE TESTS
// ═══════════════════════════════════════════════════════════════════

const GROUPBY_TESTS: TestCase[] = [
    {
        name: 'SUM revenue by region',
        fn: () => {
            const result = executeAggregation(SAMPLE_SALES, {
                metricColumn: 'revenue',
                aggregation: AggregationType.SUM,
                dimensionColumn: 'region',
                sort: 'desc',
            });
            const regionValues: Record<string, number> = {};
            result.data.forEach(d => { regionValues[d.region] = d.revenue; });
            assertEqual(regionValues['North'], 3000, 'North revenue should be 3000');
            assertEqual(regionValues['South'], 2900, 'South revenue should be 2900');
            assertEqual(regionValues['East'], 2000, 'East revenue should be 2000');
            assertEqual(regionValues['West'], 1200, 'West revenue should be 1200');
        },
    },
    {
        name: 'AVG price by product (non-additive metric)',
        fn: () => {
            const result = executeAggregation(SAMPLE_SALES, {
                metricColumn: 'price',
                aggregation: AggregationType.AVG,
                dimensionColumn: 'product',
            });
            const productValues: Record<string, number> = {};
            result.data.forEach(d => { productValues[d.product] = d.price; });
            assertEqual(productValues['Laptop'], 1200, 'Laptop AVG price should be 1200');
            assertEqual(productValues['Phone'], 400, 'Phone AVG price should be 400');
            assertEqual(productValues['Tablet'], 500, 'Tablet AVG price should be 500');
        },
    },
    {
        name: 'Grand total (no dimension)',
        fn: () => {
            const result = executeAggregation(SAMPLE_SALES, {
                metricColumn: 'revenue',
                aggregation: AggregationType.SUM,
                dimensionColumn: null,
            });
            assertEqual(result.data.length, 1, 'Grand total should have 1 row');
            assertEqual(result.data[0].revenue, 9100, 'Grand total revenue should be 9100');
        },
    },
    {
        name: 'Limit results to top 2',
        fn: () => {
            const result = executeAggregation(SAMPLE_SALES, {
                metricColumn: 'revenue',
                aggregation: AggregationType.SUM,
                dimensionColumn: 'region',
                sort: 'desc',
                limit: 2,
            });
            assertEqual(result.data.length, 2, 'Should return only 2 rows');
            assertEqual(result.data[0].region, 'North', 'Top region should be North');
        },
    },
];

// ═══════════════════════════════════════════════════════════════════
// FILTER TESTS
// ═══════════════════════════════════════════════════════════════════

const FILTER_TESTS: TestCase[] = [
    {
        name: 'Filter by region = North',
        fn: () => {
            const filtered = filterRows(SAMPLE_SALES, [{ column: 'region', operator: '=', value: 'North' }]);
            assertEqual(filtered.length, 3, 'Should have 3 North rows');
        },
    },
    {
        name: 'Filter by revenue > 1000',
        fn: () => {
            const filtered = filterRows(SAMPLE_SALES, [{ column: 'revenue', operator: '>', value: 1000 }]);
            assertEqual(filtered.length, 4, 'Should have 4 rows with revenue > 1000');
        },
    },
    {
        name: 'Filter by product IN [Laptop, Tablet]',
        fn: () => {
            const filtered = filterRows(SAMPLE_SALES, [{ column: 'product', operator: 'IN', value: ['Laptop', 'Tablet'] }]);
            assertEqual(filtered.length, 5, 'Should have 5 rows for Laptop + Tablet');
        },
    },
    {
        name: 'Filtered aggregation',
        fn: () => {
            const result = executeAggregation(SAMPLE_SALES, {
                metricColumn: 'revenue',
                aggregation: AggregationType.SUM,
                dimensionColumn: null,
                filters: [{ column: 'region', operator: '=', value: 'North' }],
            });
            assertEqual(result.data[0].revenue, 3000, 'Filtered SUM(revenue) for North should be 3000');
            assertEqual(result.rowsFiltered, 5, 'Should have filtered out 5 rows');
        },
    },
];

// ═══════════════════════════════════════════════════════════════════
// METRIC REGISTRY TESTS
// ═══════════════════════════════════════════════════════════════════

const REGISTRY_TESTS: TestCase[] = [
    {
        name: 'Revenue → SUM, additive',
        fn: () => {
            const result = classifyMetric('revenue');
            assertEqual(result?.aggregation, AggregationType.SUM, 'revenue should be SUM');
            assertEqual(result?.behavior, 'additive', 'revenue should be additive');
        },
    },
    {
        name: 'Price → AVG, non-additive',
        fn: () => {
            const result = classifyMetric('price');
            assertEqual(result?.aggregation, AggregationType.AVG, 'price should be AVG');
            assertEqual(result?.behavior, 'non_additive', 'price should be non-additive');
        },
    },
    {
        name: 'Quantity → SUM, additive',
        fn: () => {
            const result = classifyMetric('quantity');
            assertEqual(result?.aggregation, AggregationType.SUM, 'quantity should be SUM');
            assertEqual(result?.behavior, 'additive', 'quantity should be additive');
        },
    },
    {
        name: 'discount_rate → AVG, non-additive, percent',
        fn: () => {
            const result = classifyMetric('discount_rate');
            assertEqual(result?.aggregation, AggregationType.AVG, 'discount_rate should be AVG');
            assertEqual(result?.format, 'percent', 'discount_rate should be percent format');
        },
    },
    {
        name: 'Unknown column returns null',
        fn: () => {
            const result = classifyMetric('foobar_xyz');
            assertEqual(result, null, 'Unknown column should return null');
        },
    },
];

// ═══════════════════════════════════════════════════════════════════
// JOIN VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════

const JOIN_TESTS: TestCase[] = [
    {
        name: 'ONE_TO_MANY detection',
        fn: () => {
            const orders = [
                { order_id: '1', customer_id: 'C1' },
                { order_id: '2', customer_id: 'C1' },
                { order_id: '3', customer_id: 'C2' },
            ];
            const customers = [
                { customer_id: 'C1', name: 'Alice' },
                { customer_id: 'C2', name: 'Bob' },
            ];
            const result = detectCardinality(orders, customers, 'customer_id', 'customer_id');
            assertEqual(result.relationship, 'MANY_TO_ONE', 'Orders → Customers should be MANY_TO_ONE');
            assertEqual(result.isValid, true, 'Should be valid');
        },
    },
    {
        name: 'Fan-out detection',
        fn: () => {
            const left = [{ id: 1 }, { id: 2 }];
            // Simulating a bad join that produced duplicates
            const right = [{ id: 1 }, { id: 2 }];
            const joined = [{ id: 1 }, { id: 1 }, { id: 2 }, { id: 2 }, { id: 1 }]; // 5 rows from 2 = fan-out

            const result = validateJoin(left, right, joined, 'left', 'right', 'id', 'id');
            assertEqual(result.valid, false, 'Fan-out join should be invalid');
        },
    },
    {
        name: 'Valid join passes',
        fn: () => {
            const left = [{ id: 1 }, { id: 2 }, { id: 3 }];
            const right = [{ id: 1 }, { id: 2 }];
            const joined = [{ id: 1 }, { id: 2 }, { id: 3 }]; // Same count = valid

            const result = validateJoin(left, right, joined, 'left', 'right', 'id', 'id');
            assertEqual(result.valid, true, 'Same-count join should be valid');
        },
    },
];

// ═══════════════════════════════════════════════════════════════════
// TEST RUNNER
// ═══════════════════════════════════════════════════════════════════

/**
 * Run all test suites and return results.
 */
export function runAllTests(): { results: TestResult[]; passed: number; failed: number; total: number } {
    const allTests: TestCase[] = [
        ...AGGREGATION_TESTS,
        ...GROUPBY_TESTS,
        ...FILTER_TESTS,
        ...REGISTRY_TESTS,
        ...JOIN_TESTS,
    ];

    const results: TestResult[] = [];
    let passed = 0;
    let failed = 0;

    for (const test of allTests) {
        try {
            test.fn();
            results.push({ name: test.name, passed: true });
            passed++;
        } catch (e: any) {
            results.push({ name: test.name, passed: false, error: e.message });
            failed++;
        }
    }

    // Log summary
    console.log(`\n══════════════════════════════════════════`);
    console.log(`  Analytics Test Results: ${passed}/${allTests.length} passed`);
    console.log(`══════════════════════════════════════════`);

    for (const r of results) {
        if (r.passed) {
            console.log(`  ✅ ${r.name}`);
        } else {
            console.log(`  ❌ ${r.name}`);
            console.log(`     ${r.error}`);
        }
    }

    console.log(`\n  Total: ${allTests.length} | Passed: ${passed} | Failed: ${failed}\n`);

    return { results, passed, failed, total: allTests.length };
}
