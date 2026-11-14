/**
 * Error reports never carry values from a person's data: quoted text, email
 * addresses, long numbers and query strings are removed in the browser and
 * again on the server, with the same rules.
 */
import { describe, expect, it } from 'vitest';
import { scrubErrorText } from '../services/errorReporter';

const { scrub, cleanReport, createClientErrorService } = require('../backend/clientErrors.js');

const samples = [
    `TypeError: Cannot read properties of undefined (reading 'Acme Ltd')`,
    'Error: Value "Jane Smith, 14 High St" is not a date',
    'Invalid customer bob.smith@shop.co.uk on row 123456',
    'Failed at https://quickinsight.co.uk/dashboard?token=abc#section',
    'RangeError: `£12,345.67` is out of range',
];

describe('error reports', () => {
    it('remove anything that could be a value from the data', () => {
        for (const text of samples) {
            const cleaned = scrub(text, 300);
            expect(cleaned).not.toMatch(/Acme|Jane|High St|bob\.smith|123456|token=abc|12,345/);
        }
        expect(scrub(samples[0], 300)).toBe('TypeError: Cannot read properties of undefined (reading "…")');
    });

    it('use the same rules in the browser and on the server', () => {
        for (const text of samples) expect(scrubErrorText(text, 300)).toBe(scrub(text, 300));
    });

    it('are cut to size, and an empty one is dropped', () => {
        expect(cleanReport({ message: 'x'.repeat(1000), stack: 'y'.repeat(5000), path: '/a?b=1', kind: 'weird' }))
            .toMatchObject({ message: 'x'.repeat(300), stack: 'y'.repeat(2000), path: '/a', kind: 'error' });
        expect(cleanReport({ message: '   ' })).toBeNull();
    });

    it('are stored with the account, if any, and summarised for the admin', async () => {
        const inserted: any[][] = [];
        const pool = { query: async (sql: string, params: any[] = []) => { if (/^INSERT/.test(sql.trim())) inserted.push(params); return { rows: [], rowCount: 0 }; } };
        const service = createClientErrorService({ getPool: () => pool });
        expect(await service.record('u1', { message: `Error: bad 'Acme'`, kind: 'render', path: '/x' })).toBe(true);
        expect(inserted[0]).toEqual(['u1', 'render', 'Error: bad "…"', '', '/x', '']);
        expect(await service.record(undefined, {})).toBe(false);
    });
});
