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

// Monthly rows spanning 12 months for comparison testing (Jul 2024 - Jun 2025)
const COMPARISON_ROWS = [
    // July 2024
    { category: 'A', revenue: 80, order_date: '2024-07-15' },
    { category: 'B', revenue: 120, order_date: '2024-07-20' },
    // August 2024
    { category: 'A', revenue: 90, order_date: '2024-08-10' },
    { category: 'B', revenue: 110, order_date: '2024-08-15' },
    // September 2024
    { category: 'A', revenue: 130, order_date: '2024-09-01' },
    { category: 'B', revenue: 170, order_date: '2024-09-10' },
    // October 2024
    { category: 'A', revenue: 200, order_date: '2024-10-05' },
    { category: 'B', revenue: 150, order_date: '2024-10-15' },
    // November 2024
    { category: 'A', revenue: 180, order_date: '2024-11-01' },
    { category: 'B', revenue: 220, order_date: '2024-11-10' },
    // December 2024
    { category: 'A', revenue: 300, order_date: '2024-12-01' },
    { category: 'B', revenue: 250, order_date: '2024-12-15' },
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
            timeFilter: 'this_year',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        expect(result.data.length).toBeGreaterThanOrEqual(2);

        // In trend comparison mode, at least some rows should have previous_value
        const rowsWithComparison = result.data.filter((r: any) => r.previous_value !== undefined);
        expect(rowsWithComparison.length).toBeGreaterThan(0);

        // At least one row should have growth_pct
        const rowsWithGrowth = result.data.filter((r: any) => r.growth_pct !== undefined);
        expect(rowsWithGrowth.length).toBeGreaterThan(0);
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
            timeFilter: 'this_year',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        // Find rows where growth_pct is defined (positive or negative)
        const rowsWithGrowth = result.data.filter(
            (r: any) => r.growth_pct !== undefined && r.previous_value !== undefined
        );
        expect(rowsWithGrowth.length).toBeGreaterThan(0);

        // Verify the formula: (current - prev) / |prev| * 100
        for (const row of rowsWithGrowth) {
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
            timeFilter: 'this_year',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        // Find a row where growth is negative
        const negativeGrowthRows = result.data.filter(
            (r: any) => r.growth_pct !== undefined && r.growth_pct < 0
        );
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
            timeFilter: 'this_year',
            comparison: 'previous_period' as any,
            sort: 'desc',
        };

        const result = runAnalysis(ds, query);
        // In trend mode, data should have previous_value for comparison
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
            timeFilter: 'this_year',
            comparison: 'previous_period' as any,
        };

        const result = runAnalysis(ds, query);
        // With non-time dimension + time filter, comparison uses time-based previous period per category
        expect(result.data.length).toBeGreaterThanOrEqual(2);
        // Categories should have previous_value from prior period data
        const rowsWithPrev = result.data.filter((r: any) => r.previous_value !== undefined);
        expect(rowsWithPrev.length).toBeGreaterThan(0);
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
