import { describe, expect, it } from 'vitest';
import { buildEntityPresentationContext, extractSQL } from './directSqlEngine';
import type { SemanticModel } from './types';

const model = {
    fields: [
        { name: 'customer_id', semanticType: 'identifier', role: 'dimension' },
        { name: 'customer_name', semanticType: 'category', role: 'dimension' },
        { name: 'sales', semanticType: 'currency', role: 'metric' },
    ],
} as unknown as SemanticModel;

describe('AI SQL presentation context', () => {
    it('marks a readable entity field as the visible answer over its paired ID', () => {
        const context = buildEntityPresentationContext(model);
        expect(context).toContain('customer_name is the human-readable display field for customer_id');
        expect(context).toContain('use customer_name as the visible answer');
    });

    it('does not add presentation context when semantic metadata is unavailable', () => {
        expect(buildEntityPresentationContext()).toBe('');
    });

    it('keeps SQL extraction compatible with fenced model output', () => {
        expect(extractSQL('```sql\nSELECT * FROM data;\n```')).toBe('SELECT * FROM data');
    });
});
