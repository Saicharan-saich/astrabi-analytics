import { describe, it, expect } from 'vitest';
import { reconcileRolesWithData } from '../services/aiSemanticProfiler';
import { runETLPipeline } from '../services/etlPipeline';
import { ColumnType } from '../types';
import type { ColumnSemantic } from '../types';

const sem = (role: ColumnType, over: Partial<ColumnSemantic> = {}): ColumnSemantic => ({
    role, aggregation: 'NONE', format: 'raw', humanLabel: '', description: '',
    semanticRole: 'other', isHidden: false, ...over,
} as ColumnSemantic);

describe('reconcileRolesWithData — deterministic role wins over AI misfires', () => {
    it('AI-labelled patient names as ID → corrected to the ETL DIMENSION', () => {
        // The exact reported data: person names with chaotic casing.
        const names = ['DaNnY sMitH', 'andrEw waTtS', 'adrIENNE bEll', 'EMILY JOHNSOn',
            'edwArD EDWaRDs', 'CHrisTInA MARtinez', 'JASmINe aGuIlaR', 'ChRISTopher BerG',
            'mIchElLe daniELs', 'aaRon MARtiNeZ', 'connOR HANsEn', 'rObeRt bAuer'];
        const rows = names.map((n, i) => ({ name: n, age: 20 + (i % 40) }));
        const { columns } = runETLPipeline(rows, 'patients.csv');
        // Sanity: the deterministic classifier already gets it right.
        expect(columns.find(c => c.name === 'name')?.type).toBe(ColumnType.DIMENSION);

        // The AI wrongly calls the name column an ID.
        const semantics: Record<string, ColumnSemantic> = {
            name: sem(ColumnType.ID, { humanLabel: 'Patient Name' }),
            age: sem(ColumnType.DIMENSION),
        };
        reconcileRolesWithData(semantics, columns);
        expect(semantics.name.role).toBe(ColumnType.DIMENSION); // corrected
    });

    it('leaves a genuine ID (agreed by the ETL) as ID', () => {
        const rows = Array.from({ length: 30 }, (_, i) => ({ customer_id: 1000 + i, sales: i * 10 }));
        const { columns } = runETLPipeline(rows, 'orders.csv');
        const semantics: Record<string, ColumnSemantic> = {
            customer_id: sem(ColumnType.ID),
            sales: sem(ColumnType.METRIC, { aggregation: 'SUM' }),
        };
        reconcileRolesWithData(semantics, columns);
        expect(semantics.customer_id.role).toBe(ColumnType.ID); // preserved
        expect(semantics.sales.role).toBe(ColumnType.METRIC);    // preserved
    });

    it('rejects METRIC on a date column', () => {
        const rows = Array.from({ length: 12 }, (_, i) => ({ order_date: `2024-${String(i + 1).padStart(2, '0')}-01`, amount: i * 5 }));
        const { columns } = runETLPipeline(rows, 'd.csv');
        const semantics: Record<string, ColumnSemantic> = {
            order_date: sem(ColumnType.METRIC, { aggregation: 'SUM' }),
            amount: sem(ColumnType.METRIC, { aggregation: 'SUM' }),
        };
        reconcileRolesWithData(semantics, columns);
        expect(semantics.order_date.role).toBe(ColumnType.DATE); // corrected
        expect(semantics.amount.role).toBe(ColumnType.METRIC);   // preserved
    });
});
