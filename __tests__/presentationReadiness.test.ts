import { describe, expect, it } from 'vitest';
import { isItemPresentable, summariseDashboardReadiness } from '../utils/presentationReadiness';

const dataset = { id: 'sales', name: 'Sales.csv', rows: [], columns: [], totalRows: 0, etlLogs: [] } as any;
const item = (over: any = {}) => ({
    id: 'i', title: 'Card', width: 'half', datasetId: 'sales', datasetName: 'Sales.csv',
    result: { data: [{ region: 'North', sales: 1 }], xKey: 'region', yKey: 'sales' },
    ...over,
}) as any;

describe('presentation readiness', () => {
    it('presents a visual whose dataset is loaded', () => {
        expect(isItemPresentable(item(), dataset, [dataset], 0)).toBe(true);
    });

    it('presents a stored result without its dataset only when no filter needs the rows', () => {
        const orphan = item({ datasetId: 'other', datasetName: 'Other.xlsx' });
        expect(isItemPresentable(orphan, dataset, [dataset], 0)).toBe(true);
        expect(isItemPresentable(orphan, dataset, [dataset], 1)).toBe(false);
        expect(isItemPresentable({ ...orphan, ignoreGlobalFilter: true }, dataset, [dataset], 1)).toBe(true);
    });

    it('skips cloud-restored cards that need their dataset', () => {
        const restored = item({ datasetId: 'other', datasetName: 'Other.xlsx', result: { needsLocalData: true, data: [] } });
        expect(isItemPresentable(restored, dataset, [dataset], 0)).toBe(false);
    });

    it('summarises a dashboard with the datasets still needed', () => {
        const summary = summariseDashboardReadiness({
            id: 'd', name: 'Retail', layout: null, filters: [], createdAt: 0,
            items: [item(), item({ id: 'x', datasetId: 'other', datasetName: 'Other.xlsx', result: { needsLocalData: true } })],
        } as any, dataset, [dataset]);
        expect(summary).toMatchObject({ total: 2, ready: 1, missingDatasets: ['Other.xlsx'] });
    });
});
