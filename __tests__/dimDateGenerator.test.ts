import { describe, it, expect } from 'vitest';
import { generateDimDate } from '../services/dimDateGenerator';

describe('generateDimDate', () => {
    it('generates correct number of rows for a known range', () => {
        const result = generateDimDate('2024-01-01', '2024-01-31');
        expect(result).toHaveLength(31);
    });

    it('returns empty array for invalid range', () => {
        expect(generateDimDate('2024-12-31', '2024-01-01')).toHaveLength(0);
        expect(generateDimDate('', '')).toHaveLength(0);
    });

    it('returns single row for same start and end', () => {
        const result = generateDimDate('2024-06-15', '2024-06-15');
        expect(result).toHaveLength(1);
        expect(result[0].date_key).toBe('2024-06-15');
    });

    it('produces correct calendar attributes for known date', () => {
        const result = generateDimDate('2024-12-25', '2024-12-25');
        const row = result[0];

        expect(row.date_key).toBe('2024-12-25');
        expect(row.year).toBe(2024);
        expect(row.quarter).toBe(4);
        expect(row.quarter_label).toBe('Q4 2024');
        expect(row.month).toBe(12);
        expect(row.month_name).toBe('December');
        expect(row.month_short).toBe('Dec');
        expect(row.day_of_month).toBe(25);
        expect(row.day_name).toBe('Wednesday');
        expect(row.is_weekend).toBe(false);
    });

    it('correctly identifies weekends', () => {
        // Saturday Dec 28 2024  
        const sat = generateDimDate('2024-12-28', '2024-12-28')[0];
        expect(sat.is_weekend).toBe(true);
        expect(sat.day_of_week).toBe(6); // ISO: Sat=6

        // Sunday Dec 29 2024
        const sun = generateDimDate('2024-12-29', '2024-12-29')[0];
        expect(sun.is_weekend).toBe(true);
        expect(sun.day_of_week).toBe(7); // ISO: Sun=7

        // Monday Dec 30 2024
        const mon = generateDimDate('2024-12-30', '2024-12-30')[0];
        expect(mon.is_weekend).toBe(false);
        expect(mon.day_of_week).toBe(1); // ISO: Mon=1
    });

    it('computes fiscal year correctly (April start)', () => {
        // March → fiscal year stays same
        const mar = generateDimDate('2024-03-15', '2024-03-15')[0];
        expect(mar.fiscal_year).toBe(2024);
        expect(mar.fiscal_quarter).toBe(4);

        // April → fiscal year = calendar year + 1
        const apr = generateDimDate('2024-04-15', '2024-04-15')[0];
        expect(apr.fiscal_year).toBe(2025);
        expect(apr.fiscal_quarter).toBe(1);
    });

    it('handles leap year correctly', () => {
        const result = generateDimDate('2024-02-28', '2024-03-01');
        expect(result).toHaveLength(3); // Feb 28, Feb 29, Mar 1
        expect(result[1].date_key).toBe('2024-02-29');
        expect(result[1].day_of_month).toBe(29);
    });

    it('generates a full year with 366 rows for a leap year', () => {
        const result = generateDimDate('2024-01-01', '2024-12-31');
        expect(result).toHaveLength(366);
        expect(result[0].date_key).toBe('2024-01-01');
        expect(result[365].date_key).toBe('2024-12-31');
    });

    it('has continuous date_key values with no gaps', () => {
        const result = generateDimDate('2024-06-01', '2024-06-30');
        for (let i = 1; i < result.length; i++) {
            const prev = new Date(result[i - 1].date_key + 'T00:00:00Z');
            const curr = new Date(result[i].date_key + 'T00:00:00Z');
            const diffDays = (curr.getTime() - prev.getTime()) / (86400 * 1000);
            expect(diffDays).toBe(1);
        }
    });
});
