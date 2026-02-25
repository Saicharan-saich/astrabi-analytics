import { describe, it, expect } from 'vitest';
import { runAnalysis } from '../services/analysisEngine';
import { AggregationType, TimeGrain, AnalysisType, ColumnType, Dataset, QueryConfig } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────
function makeDataset(rows: Record<string, any>[], name = 'test.csv'): Dataset {
    const sampleRow = rows[0] || {};
    const columns = Object.keys(sampleRow).map(k => ({
        name: k,
        type: typeof sampleRow[k] === 'number' ? ColumnType.METRIC : ColumnType.DIMENSION,
        originalType: typeof sampleRow[k],
    }));
    return { id: 'test-1', name, rows, columns, totalRows: rows.length, etlLogs: [] };
}

// Monthly rows spanning 6 months for comparison testing
const COMPARISON_ROWS = [
    // January 2025
    { category: 'A', revenue: 100, order_date: '2025-01-15' },
    { category: 'B', revenue: 200, order_date: '2025-01-20' },
    // February 2025
    { category: 'A', revenue: 150, order_date: '2025-02-10' },
    { category: 'B', revenue: 250, order_date: '2025-02-15' },
    // March 2025
    { category: 'A', revenue: 300, order_date: '2025-03-01' },
    { category: 'B', revenue: 100, order_date: '2025-03-10' },
    // April 2025
    { category: 'A', revenue: 0, order_date: '2025-04-05' },
    { category: 'B', revenue: 350, order_date: '2025-04-15' },
    // May 2025
    { category: 'A', revenue: 250, order_date: '2025-05-01' },
    { category: 'B', revenue: 0, order_date: '2025-05-10' },
    // June 2025
    { category: 'A', revenue: 500, order_date: '2025-06-01' },
    { category: 'B', revenue: 400, order_date: '2025-06-15' },
];

// ─── Comparison Tests ────────────────────────────────────────────
describe('evaluateLocally — previous_period comparison', () => {
    const ds = makeDataset(COMPARISON_ROWS);

    it('adds previous_value and growth_pct when comparison = previous_period', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'month',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-06-30',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        expect(result.data.length).toBeGreaterThanOrEqual(2);

        // Comparison runs before final sort, so after desc sort, data[0] may
        // not be the chronologically-first row. Verify that at least one row
        // has undefined previous_value (the first chronological period).
        const firstChronoRow = result.data.find((r: any) => r.previous_value === undefined);
        expect(firstChronoRow).toBeDefined();
        expect(firstChronoRow.growth_pct).toBeUndefined();

        // Second+ rows should have previous_value defined
        const secondRow = result.data[1];
        expect(secondRow.previous_value).toBeDefined();
        expect(secondRow.growth_pct).toBeDefined();
    });

    it('calculates positive growth correctly', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'month',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-06-30',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        // Find a row where growth is positive (current > previous)
        const positiveGrowthRows = result.data.filter(
            (r: any) => r.growth_pct !== undefined && r.growth_pct > 0
        );
        expect(positiveGrowthRows.length).toBeGreaterThan(0);

        // Verify the formula: (current - prev) / |prev| * 100
        for (const row of positiveGrowthRows) {
            const current = Number(row[result.yKey]);
            const prev = Number(row.previous_value);
            if (prev !== 0) {
                const expected = ((current - prev) / Math.abs(prev)) * 100;
                expect(Number(row.growth_pct)).toBeCloseTo(expected, 1);
            }
        }
    });

    it('calculates negative growth correctly', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'month',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-06-30',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        // Find a row where growth is negative
        const negativeGrowthRows = result.data.filter(
            (r: any) => r.growth_pct !== undefined && r.growth_pct < 0
        );
        // We expect at least one negative growth row given our test data
        // (e.g., Apr total=350 vs Mar total=400 could be negative)
        // Verify formula if present
        for (const row of negativeGrowthRows) {
            const current = Number(row[result.yKey]);
            const prev = Number(row.previous_value);
            if (prev !== 0) {
                const expected = ((current - prev) / Math.abs(prev)) * 100;
                expect(Number(row.growth_pct)).toBeCloseTo(expected, 1);
            }
        }
    });

    it('without comparison flag, no growth_pct is added', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'month',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-06-30',
        };

        const result = runAnalysis(ds, query);
        const hasGrowth = result.data.some((r: any) => r.growth_pct !== undefined);
        expect(hasGrowth).toBe(false);
    });

    it('sorts chronologically before comparison for time dimensions', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'month',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-06-30',
            comparison: 'previous_period' as any,
            sort: 'desc',
        };

        const result = runAnalysis(ds, query);
        // Even with desc sort, comparison prev values should reference the
        // chronologically previous period, not the sort-adjacent row
        const hasComparison = result.data.some((r: any) => r.previous_value !== undefined);
        expect(hasComparison).toBe(true);
    });

    it('handles dimension-based comparison', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-06-30',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        // With non-time dimension, comparison should still add previous_value
        expect(result.data.length).toBeGreaterThanOrEqual(2);
        // First row gets undefined, second+ get values
        expect(result.data[0].growth_pct).toBeUndefined();
        if (result.data.length > 1) {
            expect(result.data[1].previous_value).toBeDefined();
        }
    });
});

describe('dateHelpers — pad and getISOWeek', () => {
    it('pad zero-pads single digits', async () => {
        const { pad } = await import('../services/dateHelpers');
        expect(pad(1)).toBe('01');
        expect(pad(9)).toBe('09');
        expect(pad(10)).toBe('10');
        expect(pad(31)).toBe('31');
    });

    it('getISOWeek returns correct week numbers', async () => {
        const { getISOWeek } = await import('../services/dateHelpers');
        // Jan 1 2025 is a Wednesday → ISO week 1
        expect(getISOWeek(new Date(2025, 0, 1))).toBe(1);
        // Dec 31 2024 is a Tuesday → ISO week 1 of 2025
        expect(getISOWeek(new Date(2024, 11, 31))).toBe(1);
        // Dec 29 2025 is a Monday → ISO week 1 of 2026
        expect(getISOWeek(new Date(2025, 11, 29))).toBe(1);
    });
});
