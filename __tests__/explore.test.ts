import { describe, expect, it } from 'vitest';
import {
    dashboardExcludeFilter, dashboardFilterFor, dashboardFilterIsActive, drillConfig, drillOptions,
    excludeConfig, keepConfig, periodRange, resolveTargets, rowMatchesTargets, rowsForBuilderConfig,
} from '../utils/explore';

const rows = [
    ...['Electronics', 'Electronics', 'Electronics', 'Apparel', 'Apparel', 'Toys'].flatMap((category, i) =>
        ['Contoso', 'Fabrikam'].map((vendor, j) => ({
            order_id: `O${i}${j}`,
            order_date: `2024-0${1 + ((i + j) % 6)}-1${j}`,
            category,
            vendor,
            country: j ? 'UK' : 'USA',
            city: j ? 'Leeds' : 'Boston',
            revenue: 100 + i * 10 + j,
        }))),
];
const dataset: any = {
    id: 'd', name: 'Sales', rows, totalRows: rows.length, etlLogs: [],
    timeContext: { minDate: '2024-01-10', maxDate: '2024-06-11', defaultAnchorDate: '2024-06-11', anchorDateColumn: 'order_date', dateColumnMaxDates: {} },
    columns: [
        { name: 'order_id', type: 'ID' }, { name: 'order_date', type: 'DATE' }, { name: 'category', type: 'DIMENSION' },
        { name: 'vendor', type: 'DIMENSION' }, { name: 'country', type: 'DIMENSION' }, { name: 'city', type: 'DIMENSION' },
        { name: 'revenue', type: 'METRIC' },
    ],
};
const at = { x: 0, y: 0 };

describe('periods from chart labels', () => {
    it('reads every bucket format the app produces', () => {
        expect(periodRange('2024')).toEqual({ grain: 'year', from: '2024-01-01', to: '2024-12-31' });
        expect(periodRange('2024-Q2')).toEqual({ grain: 'quarter', from: '2024-04-01', to: '2024-06-30' });
        expect(periodRange('Q4 2023')).toEqual({ grain: 'quarter', from: '2023-10-01', to: '2023-12-31' });
        expect(periodRange('2024-02')).toEqual({ grain: 'month', from: '2024-02-01', to: '2024-02-29' });
        expect(periodRange('2024-W01')).toEqual({ grain: 'week', from: '2024-01-01', to: '2024-01-07' });
        expect(periodRange('2024-03-15')).toEqual({ grain: 'day', from: '2024-03-15', to: '2024-03-15' });
        expect(periodRange('Mar 2024')).toEqual({ grain: 'month', from: '2024-03-01', to: '2024-03-31' });
        expect(periodRange('w/c 4 Mar 2024')).toEqual({ grain: 'week', from: '2024-03-04', to: '2024-03-10' });
        expect(periodRange('Electronics')).toBeNull();
    });
});

describe('what a click means', () => {
    it('maps a category bar, and its series, to filters', () => {
        const targets = resolveTargets(dataset, 'category', { value: 'Electronics', label: 'Electronics', seriesKey: 'vendor', seriesValue: 'Contoso' });
        expect(targets).toEqual([
            { kind: 'column', column: 'category', value: 'Electronics', label: 'Electronics' },
            { kind: 'column', column: 'vendor', value: 'Contoso', label: 'Contoso' },
        ]);
        expect(rows.filter(r => rowMatchesTargets(r, targets))).toHaveLength(3);
    });

    it('maps a month bucket to a date range on the date column', () => {
        const [target] = resolveTargets(dataset, 'month', { value: '2024-03', label: 'Mar 2024' });
        expect(target).toMatchObject({ kind: 'period', grain: 'month', dateColumn: 'order_date', from: '2024-03-01', to: '2024-03-31' });
    });

    it('ignores series that are not real columns (combined labels)', () => {
        expect(resolveTargets(dataset, 'category', { value: 'Toys', label: 'Toys', seriesKey: '__combined', seriesValue: 'a · b' })).toHaveLength(1);
    });
});

describe('Question Builder actions', () => {
    const base = { metric: 'revenue', dimension: 'category', aggregation: 'SUM', filters: {} };

    it('suggests related dimensions that vary inside the selection, then time', () => {
        const targets = resolveTargets(dataset, 'country', { value: 'UK', label: 'UK' });
        const options = drillOptions(dataset, { ...base, dimension: 'country' }, targets);
        // city is the next level under country, but has one value inside UK → not offered.
        expect(options.map(o => o.value)).not.toContain('city');
        expect(options.map(o => o.value)).toContain('category');
        expect(options[options.length - 1]).toMatchObject({ kind: 'grain', value: 'month' });
    });

    it('offers the next time levels for a period', () => {
        const targets = resolveTargets(dataset, 'quarter', { value: '2024-Q1', label: '2024-Q1' });
        expect(drillOptions(dataset, { ...base, dimension: 'quarter' }, targets).slice(0, 2).map(o => o.value)).toEqual(['month', 'week']);
    });

    it('keeps, excludes and drills', () => {
        const [target] = resolveTargets(dataset, 'category', { value: 'Electronics', label: 'Electronics' }) as any;
        expect(keepConfig(base, [target]).filters).toEqual({ category: ['Electronics'] });
        expect(excludeConfig(dataset, base, target).filters.category.sort()).toEqual(['Apparel', 'Toys']);
        const drilled = drillConfig({ ...base, secondaryDimensions: ['vendor'] }, [target], { kind: 'column', value: 'vendor', label: 'by vendor' });
        expect(drilled).toMatchObject({ dimension: 'vendor', filters: { category: ['Electronics'] } });
        expect(drilled.secondaryDimensions).toBeUndefined();
        expect(rowsForBuilderConfig(dataset, drilled)).toHaveLength(6);
    });

    it('drills a month into days with a date range filter', () => {
        const targets = resolveTargets(dataset, 'month', { value: '2024-03', label: 'Mar 2024' });
        const drilled = drillConfig({ ...base, dimension: 'month', timeFilter: 'last_90_days', limit: 5 }, targets, { kind: 'grain', value: 'day', label: 'by day' });
        expect(drilled).toMatchObject({ dimension: 'day', sort: 'oldest', dateFilters: [{ column: 'order_date', values: ['2024-03-01__2024-03-31'] }] });
        expect(drilled.limit).toBeUndefined();
        expect(drilled.timeFilter).toBeUndefined();
        expect(rowsForBuilderConfig(dataset, drilled).every(r => r.order_date.startsWith('2024-03'))).toBe(true);
    });
});

describe('dashboard cross-filtering', () => {
    it('turns a click into a dashboard filter and recognises it when active', () => {
        const [target] = resolveTargets(dataset, 'category', { value: 'Toys', label: 'Toys' });
        const filter = dashboardFilterFor(target);
        expect(filter).toEqual({ column: 'category', type: 'dimension', values: ['Toys'] });
        expect(dashboardFilterIsActive([filter], target)).toBe(true);
        expect(dashboardExcludeFilter(rows, target as any).values).toEqual(['Apparel', 'Electronics']);
        const [period] = resolveTargets(dataset, 'month', { value: '2024-02', label: 'Feb 2024' });
        expect(dashboardFilterFor(period)).toMatchObject({ column: 'order_date', dateMode: 'range', dateRange: { from: '2024-02-01', to: '2024-02-29' } });
    });
});

void at;
