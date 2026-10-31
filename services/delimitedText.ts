/**
 * delimitedText.ts — reads CSV, TSV, semicolon- and pipe-separated text.
 *
 * Detects the delimiter, handles quoted cells with delimiters, quotes and line
 * breaks (RFC 4180), skips title/notes lines above the header, names blank
 * headers deterministically and never lets two columns with the same header
 * overwrite each other.
 */

/** Split delimited text into records (RFC 4180: quoted fields may hold delimiters, quotes and line breaks). */
function splitRecords(text: string, delimiter: string): string[][] {
    const records: string[][] = [];
    let field = '';
    let record: string[] = [];
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
            continue;
        }
        if (ch === '"' && field.trim() === '') { inQuotes = true; field = ''; continue; }
        if (ch === delimiter) { record.push(field.trim()); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { record.push(field.trim()); records.push(record); record = []; field = ''; continue; }
        field += ch;
    }
    if (field !== '' || record.length > 0) { record.push(field.trim()); records.push(record); }
    return records;
}

/** The delimiter that splits the first lines most consistently into the most columns. */
function detectDelimiter(text: string): string {
    const sample = text.slice(0, 20000);
    let best = ',', bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
        const widths = splitRecords(sample, d).slice(0, 30).map(r => r.length).filter(w => w > 0);
        if (widths.length === 0) continue;
        const counts = new Map<number, number>();
        for (const w of widths) counts.set(w, (counts.get(w) || 0) + 1);
        const [modeWidth, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
        if (modeWidth < 2) continue;
        const score = (modeCount / widths.length) * 10 + Math.min(modeWidth, 50) / 10;
        if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
}

/**
 * Parse CSV / TSV / semicolon / pipe text into rows. Handles a BOM, title or
 * notes lines above the header, quoted line breaks, blank and duplicate
 * header names (suffixed _2, _3 — never silently overwritten) and short rows.
 */
export function parseDelimitedText(text: string): { rows: Record<string, any>[]; delimiter: string; headerRow: number; renamedHeaders: string[] } {
    const clean = text.replace(/^﻿/, '');
    if (!clean.trim()) return { rows: [], delimiter: ',', headerRow: 0, renamedHeaders: [] };
    const delimiter = detectDelimiter(clean);
    const records = splitRecords(clean, delimiter).filter(r => r.some(cell => cell !== ''));
    if (records.length === 0) return { rows: [], delimiter, headerRow: 0, renamedHeaders: [] };

    // The header is the first row as wide as the table body: report exports
    // often carry a title, a date line or notes above it.
    const widths = records.slice(0, 50).map(r => r.filter(c => c !== '').length);
    const counts = new Map<number, number>();
    for (const w of widths) counts.set(w, (counts.get(w) || 0) + 1);
    const bodyWidth = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    // Title and note lines are narrow (one or two cells); the header is not.
    let headerRow = records.findIndex((r, i) => i < 15 && r.filter(c => c !== '').length >= Math.max(2, bodyWidth - 1));
    if (headerRow < 0) headerRow = 0;

    const rawHeaders = records[headerRow];
    const seen = new Map<string, number>();
    const renamedHeaders: string[] = [];
    const headers = rawHeaders.map((h, i) => {
        const base = h.trim() || `column_${i + 1}`;
        const key = base.toLowerCase();
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        if (n > 1) renamedHeaders.push(`${base} → ${base}_${n}`);
        return n > 1 ? `${base}_${n}` : base;
    });
    const rows: Record<string, any>[] = [];
    for (let r = headerRow + 1; r < records.length; r++) {
        const values = records[r];
        const row: Record<string, any> = {};
        for (let c = 0; c < headers.length; c++) row[headers[c]] = values[c] ?? '';
        // Extra cells beyond the header are kept rather than dropped.
        for (let c = headers.length; c < values.length; c++) if (values[c] !== '') row[`column_${c + 1}`] = values[c];
        rows.push(row);
    }
    return { rows, delimiter, headerRow, renamedHeaders };
}

