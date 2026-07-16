import { describe, it, expect } from 'vitest';
import { datasetSignature } from '../services/columnCorrectionsService';

describe('datasetSignature — schema fingerprint for correction scoping', () => {
    it('is order-independent and case-insensitive', () => {
        expect(datasetSignature(['region', 'sales', 'date']))
            .toBe(datasetSignature(['DATE', 'Region', 'SALES']));
    });

    it('ignores whitespace and empty names', () => {
        expect(datasetSignature(['  region ', 'sales', '']))
            .toBe(datasetSignature(['region', 'sales']));
    });

    it('differs when the column set differs', () => {
        // Same "region" column, but genuinely different datasets → different signatures,
        // so a correction to region in one never leaks into the other.
        const salesDs = datasetSignature(['region', 'sales', 'order_date']);
        const surveyDs = datasetSignature(['region', 'respondent_id', 'satisfaction']);
        expect(salesDs).not.toBe(surveyDs);
    });

    it('differs when a single column is added or removed', () => {
        const a = datasetSignature(['a', 'b', 'c']);
        const b = datasetSignature(['a', 'b', 'c', 'd']);
        expect(a).not.toBe(b);
    });

    it('produces a server-safe key (lowercase alphanumeric, <= 64 chars)', () => {
        const sig = datasetSignature(['Some Column', 'Another_One', 'x'.repeat(300)]);
        expect(sig).toMatch(/^[a-z0-9]{1,64}$/);
    });
});
