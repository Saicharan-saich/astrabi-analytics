import { describe, expect, it } from 'vitest';
import { resolvePhysicalBuilderFields } from '../services/questionBuilderFieldGuard';
import type { Dataset } from '../types';

const dataset = {
    id: 'healthcare',
    name: 'healthcare.csv',
    rows: [],
    totalRows: 0,
    etlLogs: [],
    columns: [
        { name: 'billing_amount', type: 'METRIC', originalType: 'DOUBLE' },
        { name: 'gender', type: 'DIMENSION', originalType: 'VARCHAR' },
        { name: 'medical_condition', type: 'DIMENSION', originalType: 'VARCHAR' },
        { name: 'date_of_admission', type: 'DATE', originalType: 'DATE' },
    ],
} as Dataset;

describe('Question Builder physical-field boundary', () => {
    it('rejects AI SQL pivot aliases instead of generating SQL for Metric or Value', () => {
        expect(resolvePhysicalBuilderFields(dataset, { metric: 'Value', dimension: 'Metric' })).toBeNull();
    });

    it('accepts a fresh user selection after reset and preserves real field names', () => {
        expect(resolvePhysicalBuilderFields(dataset, {
            metric: 'billing_amount',
            dimension: 'gender',
            secondaryMetrics: ['Value'],
            secondaryDimensions: ['Metric', 'medical_condition'],
        })).toEqual({
            metric: 'billing_amount',
            dimension: 'gender',
            secondaryMetrics: [],
            secondaryDimensions: ['medical_condition'],
        });
    });

    it('allows supported time grains while rejecting unknown synthetic dimensions', () => {
        expect(resolvePhysicalBuilderFields(dataset, { metric: 'billing_amount', dimension: 'month' })?.dimension).toBe('month');
        expect(resolvePhysicalBuilderFields(dataset, { metric: 'billing_amount', dimension: 'Unknown' })).toBeNull();
    });
});
