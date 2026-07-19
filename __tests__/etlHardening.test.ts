/**
 * ETL hardening — the correctness-critical primitives, tested exhaustively
 * because they touch the numbers directly.
 */
import { describe, it, expect } from 'vitest';
import {
    parseLocaleNumber, normalizeUnicode, resolveDateOrder, detectOutliersIQR,
    canonicalKey, buildCanonicalCategoryMap, levenshtein, findNearDuplicateGroups,
    detectSignAnomalies, detectRangeAnomalies, detectDelimitedCells, detectDateOrderViolations,
    pivotTwoDigitYear, looksLikeLeadingZeroCode, detectMixedScale,
} from '../services/etlHardening';

describe('parseLocaleNumber — recovers values that used to silently become null', () => {
    it('plain + US decimal/thousands (unchanged behaviour)', () => {
        expect(parseLocaleNumber('1234')).toBe(1234);
        expect(parseLocaleNumber('1,234')).toBe(1234);
        expect(parseLocaleNumber('1,234.56')).toBeCloseTo(1234.56, 6);
        expect(parseLocaleNumber('12,345,678')).toBe(12345678);
        expect(parseLocaleNumber(42)).toBe(42);
    });
    it('EU decimals & thousands (previously lost)', () => {
        expect(parseLocaleNumber('1.234,56')).toBeCloseTo(1234.56, 6);
        expect(parseLocaleNumber('1.234.567')).toBe(1234567);
        expect(parseLocaleNumber('1,5')).toBeCloseTo(1.5, 6);
        expect(parseLocaleNumber('1,23')).toBeCloseTo(1.23, 6);
        expect(parseLocaleNumber('1,2345')).toBeCloseTo(1.2345, 6);
    });
    it('accountant negatives & signs', () => {
        expect(parseLocaleNumber('(500)')).toBe(-500);
        expect(parseLocaleNumber('($1,200.50)')).toBeCloseTo(-1200.5, 6);
        expect(parseLocaleNumber('500-')).toBe(-500);
        expect(parseLocaleNumber('-42')).toBe(-42);
    });
    it('currency, percent, magnitude suffixes', () => {
        expect(parseLocaleNumber('$1,234.56')).toBeCloseTo(1234.56, 6);
        expect(parseLocaleNumber('€2.500,00')).toBeCloseTo(2500, 6);
        expect(parseLocaleNumber('45%')).toBe(45);
        expect(parseLocaleNumber('1.2K')).toBe(1200);
        expect(parseLocaleNumber('3M')).toBe(3_000_000);
        expect(parseLocaleNumber('2.5B')).toBe(2_500_000_000);
    });
    it('scientific notation & zero-width characters (previously lost)', () => {
        expect(parseLocaleNumber('1.23E+11')).toBeCloseTo(1.23e11, 0);
        expect(parseLocaleNumber('1.23e5')).toBeCloseTo(123000, 6);
        expect(parseLocaleNumber('1,5e3')).toBeCloseTo(1500, 6);   // EU mantissa + exponent
        expect(parseLocaleNumber('​1234﻿')).toBe(1234);   // zero-width + BOM stripped
    });
    it('genuine non-numbers → null (no false positives)', () => {
        expect(parseLocaleNumber('abc')).toBeNull();
        expect(parseLocaleNumber('')).toBeNull();
        expect(parseLocaleNumber(null)).toBeNull();
        expect(parseLocaleNumber('N/A')).toBeNull();
        expect(parseLocaleNumber('12/05/2023')).toBeNull(); // a date, not a number
        expect(parseLocaleNumber('5e')).toBeNull();          // malformed exponent
        expect(parseLocaleNumber(true as any)).toBeNull();
    });
});

describe('two-digit year pivot, leading-zero codes, mixed scale', () => {
    it('pivots 2-digit years at 30 (00–29 → 2000s, 30–99 → 1900s)', () => {
        expect(pivotTwoDigitYear(25)).toBe(2025);
        expect(pivotTwoDigitYear(0)).toBe(2000);
        expect(pivotTwoDigitYear(29)).toBe(2029);
        expect(pivotTwoDigitYear(30)).toBe(1930);
        expect(pivotTwoDigitYear(99)).toBe(1999); // a birthdate, not 2099
    });
    it('detects leading-zero code columns (keep as text, never sum)', () => {
        expect(looksLikeLeadingZeroCode(['01234', '00567', '01000', '02345'])).toBe(true);
        expect(looksLikeLeadingZeroCode(['1234', '5678', '9012', '3456'])).toBe(false); // real numbers
        expect(looksLikeLeadingZeroCode(['12.5', '3.4', '5.6', '7.8'])).toBe(false);     // decimals
    });
    it('flags a column mixing 0–1 ratios with 0–100 percentages', () => {
        const r = detectMixedScale('conversion_rate', [0.1, 0.2, 0.15, 45, 60, 30, 0.3, 55])!;
        expect(r).toBeTruthy();
        expect(r.ratioLike).toBeGreaterThanOrEqual(3);
        expect(r.pctLike).toBeGreaterThanOrEqual(3);
        expect(detectMixedScale('conversion_rate', [0.1, 0.2, 0.15, 0.3, 0.25, 0.4, 0.35, 0.5])).toBeNull(); // all ratios
    });
});

describe('normalizeUnicode', () => {
    it('repairs mojibake and smart quotes', () => {
        expect(normalizeUnicode('Café')).toBe('Café');
        expect(normalizeUnicode('Nestlé')).toBe('Nestlé');
        expect(normalizeUnicode('O’Brien')).toBe("O'Brien");
    });
    it('leaves clean text untouched', () => {
        expect(normalizeUnicode('Cardiology')).toBe('Cardiology');
    });
});

describe('resolveDateOrder — no more blind US default', () => {
    it('detects DMY when a first-part exceeds 12', () => {
        expect(resolveDateOrder(['13/05/2023', '01/06/2023', '25/12/2023'])).toBe('DMY');
    });
    it('detects MDY when a second-part exceeds 12', () => {
        expect(resolveDateOrder(['05/13/2023', '06/01/2023', '12/25/2023'])).toBe('MDY');
    });
    it('reports ambiguous when every value could be either', () => {
        expect(resolveDateOrder(['03/04/2023', '01/02/2023'])).toBe('ambiguous');
        expect(resolveDateOrder(['not a date'])).toBe('ambiguous');
    });
});

describe('detectOutliersIQR — flags the fat-fingered value', () => {
    it('catches an extreme high value among a clean run', () => {
        const vals = [...Array.from({ length: 30 }, (_, i) => 100 + i), 9_999_999];
        const r = detectOutliersIQR(vals)!;
        expect(r).toBeTruthy();
        expect(r.count).toBe(1);
        expect(r.examples).toContain(9_999_999);
    });
    it('does not flag a clean, tight distribution', () => {
        expect(detectOutliersIQR(Array.from({ length: 40 }, (_, i) => 50 + (i % 5)))).toBeNull();
    });
    it('needs enough points to be stable', () => {
        expect(detectOutliersIQR([1, 2, 3, 1000])).toBeNull();
    });
});

describe('category canonicalization (safe auto-merge) + typo flagging (review only)', () => {
    it('canonicalKey collapses case/space/punct/diacritics', () => {
        expect(canonicalKey('New-York')).toBe(canonicalKey('new york'));
        expect(canonicalKey('U.S.A.')).toBe(canonicalKey('usa'));
        expect(canonicalKey('Café')).toBe(canonicalKey('cafe'));
    });
    it('merges surface variants to the most frequent form', () => {
        const map = buildCanonicalCategoryMap(['New York', 'New York', 'new york', 'NEW YORK', 'new-york']);
        expect(map.get('new york')).toBe('New York');
        expect(map.get('NEW YORK')).toBe('New York');
        expect(map.has('New York')).toBe(false); // the canonical itself isn't remapped
    });
    it('does NOT auto-merge genuine typos — it flags them', () => {
        // "Cardilogy" vs "Cardiology" differ by one edit but are NOT canonical-equal
        const map = buildCanonicalCategoryMap(['Cardiology', 'Cardiology', 'Cardilogy']);
        expect(map.has('Cardilogy')).toBe(false); // not silently merged
        const groups = findNearDuplicateGroups(['Cardiology', 'Cardiology', 'Cardiology', 'Cardilogy']);
        expect(groups.length).toBe(1);
        expect(groups[0].canonical).toBe('Cardiology');
        expect(groups[0].variants).toContain('Cardilogy');
    });
    it('skips high-cardinality free-text columns fast (no O(n²) freeze)', () => {
        // 20k distinct names — the healthcare "name" column that used to hang.
        const names = Array.from({ length: 20000 }, (_, i) => `Person Number ${i}`);
        const t0 = Date.now();
        const groups = findNearDuplicateGroups(names);
        expect(groups).toEqual([]);            // free-text → skipped
        expect(Date.now() - t0).toBeLessThan(500); // and it returns near-instantly
    });
    it('still finds typos in a genuinely categorical column', () => {
        const rows = [...Array(50).fill('Cardiology'), ...Array(3).fill('Cardilogy'), ...Array(40).fill('Oncology')];
        const groups = findNearDuplicateGroups(rows);
        expect(groups.some(g => g.canonical === 'Cardiology' && g.variants.includes('Cardilogy'))).toBe(true);
    });
    it('levenshtein basics', () => {
        expect(levenshtein('cardiology', 'cardilogy')).toBe(1);
        expect(levenshtein('abc', 'abc')).toBe(0);
        expect(levenshtein('north', 'south', 1)).toBe(2); // ceiling exceeded → >1
    });
});

describe('business-rule validators (flag only)', () => {
    it('flags negatives in a non-negative-by-name column', () => {
        expect(detectSignAnomalies('unit_price', [10, -5, 20, -1])).toBe(2);
        expect(detectSignAnomalies('temperature', [-5, 10])).toBe(0); // temperature can be negative
    });
    it('flags out-of-range percentages and implausible ages', () => {
        expect(detectRangeAnomalies('conversion_rate_pct', [50, 120, 3, 200])!.count).toBe(2);
        expect(detectRangeAnomalies('age', [25, 199, 40, -3])!.count).toBe(2);
        expect(detectRangeAnomalies('revenue', [1, 2, 3])).toBeNull();
    });
    it('flags delimited multi-value cells', () => {
        const r = detectDelimitedCells(['red; blue', 'green; yellow', 'red; green', 'blue; red', 'x']);
        expect(r!.delimiter).toBe(';');
        expect(r!.count).toBe(4);
    });
    it('flags end-before-start date rows', () => {
        expect(detectDateOrderViolations(
            ['2024-01-10', '2024-02-01', '2024-03-01'],
            ['2024-01-05', '2024-02-15', '2024-02-20'])).toBe(2);
    });
});
