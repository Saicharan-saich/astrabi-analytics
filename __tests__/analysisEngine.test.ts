import { describe, it, expect } from 'vitest';
import { runAnalysis } from '../services/analysisEngine';
import { Dataset, ColumnType, AggregationType, TimeGrain, AnalysisType, QueryConfig } from '../types';

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

const ROWS = [
    { category: 'A', revenue: 100, order_date: '2025-03-01' },
    { category: 'A', revenue: 200, order_date: '2025-03-02' },
    { category: 'B', revenue: 150, order_date: '2025-03-01' },
    { category: 'B', revenue: 250, order_date: '2025-03-03' },
    { category: 'C', revenue: 50, order_date: '2025-03-02' },
];

// ─── Tests ────────────────────────────────────────────────────────

describe('runAnalysis — custom builder', () => {
    const ds = makeDataset(ROWS);

    it('aggregates SUM by dimension', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };

        const result = runAnalysis(ds, query);
        expect(result.data.length).toBeGreaterThanOrEqual(3); // A, B, C
        const aRow = result.data.find((d: any) => d.category === 'A');
        expect(aRow?.revenue).toBe(300);
    });

    it('aggregates COUNT by dimension', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.COUNT,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };

        const result = runAnalysis(ds, query);
        const aRow = result.data.find((d: any) => d.category === 'A');
        expect(aRow?.revenue).toBe(2);
    });

    it('aggregates AVG by dimension', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.AVG,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };

        const result = runAnalysis(ds, query);
        const aRow = result.data.find((d: any) => d.category === 'A');
        expect(aRow?.revenue).toBe(150);
    });

    it('aggregates MAX by dimension', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.MAX,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };
        const result = runAnalysis(ds, query);
        const bRow = result.data.find((d: any) => d.category === 'B');
        expect(bRow?.revenue).toBe(250);
    });

    it('aggregates MIN by dimension', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.MIN,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };
        const result = runAnalysis(ds, query);
        const bRow = result.data.find((d: any) => d.category === 'B');
        expect(bRow?.revenue).toBe(150);
    });

    it('applies limit', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
            limit: 2,
        };
        const result = runAnalysis(ds, query);
        expect(result.data.length).toBe(2);
    });

    it('applies ascending sort', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
            sort: 'asc' as any,
        };
        const result = runAnalysis(ds, query);
        const values = result.data.map((d: any) => d.revenue);
        for (let i = 1; i < values.length; i++) {
            expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
        }
    });

    it('applies dimension filter', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
            filters: { category: ['A'] },
        };
        const result = runAnalysis(ds, query);
        expect(result.data.length).toBe(1);
        expect(result.data[0].category).toBe('A');
        expect(result.data[0].revenue).toBe(300);
    });

    it('returns SQL preview', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };
        const result = runAnalysis(ds, query);
        expect(result.sql).toBeDefined();
        expect(result.sql.length).toBeGreaterThan(0);
    });

    it('returns empty when no questionId', () => {
        const query: QueryConfig = {
            questionId: '',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
        };
        const result = runAnalysis(ds, query);
        expect(result.data).toEqual([]);
    });
});

describe('runAnalysis — time dimension', () => {
    const ds = makeDataset(ROWS);

    it('groups by month', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'month',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            asOfDate: '2025-03-03',
        };
        const result = runAnalysis(ds, query);
        expect(result.data.length).toBeGreaterThanOrEqual(1);
        // All March => should collapse to 2025-03
        expect(result.data[0].month).toMatch(/^2025-03/);
    });

    it('applies time filter this_month', () => {
        const query: QueryConfig = {
            questionId: 'custom_builder',
            metric: 'revenue',
            dimension: 'category',
            aggregation: AggregationType.SUM,
            timeGrain: TimeGrain.RAW,
            analysisType: AnalysisType.STANDARD,
            timeFilter: 'this_month',
            asOfDate: '2025-03-03',
        };
        const result = runAnalysis(ds, query);
        // All rows are in March 2025 so should include all
        const total = result.data.reduce((s: number, d: any) => s + d.revenue, 0);
        expect(total).toBe(750);
    });
});
