import { afterEach, describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import { parseExcelMultiSheet } from '../services/analysisEngine';
import { readFileSync } from 'node:fs';
import { buildRelationalCatalog } from '../services/relationalCatalog';

afterEach(() => vi.unstubAllGlobals());

describe('relational workbook parsing', () => {
    it.skipIf(!process.env.QUICKINSIGHT_WORKBOOK)('imports the real workbook through the application parser without losing rows', async () => {
        const binary = readFileSync(process.env.QUICKINSIGHT_WORKBOOK!).toString('binary');
        vi.stubGlobal('FileReader', class {
            onload: any;
            readAsBinaryString() { this.onload({ target: { result: binary } }); }
        });
        const parsed = await parseExcelMultiSheet({} as File);
        const counts = Object.fromEntries(Object.entries(parsed.sheets).map(([name, rows]) => [name, rows.length]));
        expect(counts).toEqual({ Dim_Period: 4, Dim_Geography: 20, Dim_Category: 16, Dim_Currency: 6,
            Fact_Trade_Summary: 9, Fact_Country_Trade: 22, Fact_Product_Trade: 22, Fact_Service_Trade: 6,
            Fact_Service_Currency: 6, Sources: 4, Relationships: 19 });
        const catalog = buildRelationalCatalog(Object.entries(parsed.sheets).map(([name, rows]) => ({ name, rows })));
        expect(catalog.schema.joinEdges).toHaveLength(19);
    });
    it('preserves sparse records, unnamed data columns and empty sheet schemas', async () => {
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['record_id', 'description', null], ['R1', 'First', 'keep this'], ['R2', null, null],
        ]), 'Records');
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['empty_id', 'label']]), 'Empty');
        const binary = XLSX.write(book, { type: 'binary', bookType: 'xlsx' });
        vi.stubGlobal('FileReader', class {
            onload: any;
            readAsBinaryString() { this.onload({ target: { result: binary } }); }
        });
        const result = await parseExcelMultiSheet({} as File);
        expect(Object.keys(result.sheets)).toEqual(['Records', 'Empty']);
        expect(result.sheets.Records).toHaveLength(2);
        expect(result.sheets.Records[0].__EMPTY).toBe('keep this');
        expect(result.columns.Records).toContain('__EMPTY');
        expect(result.columns.Empty).toEqual(['empty_id', 'label']);
    });

    it('reports file read failures instead of leaving import pending', async () => {
        vi.stubGlobal('FileReader', class {
            onerror: any;
            error = new Error('read failed');
            readAsBinaryString() { this.onerror(); }
        });
        await expect(parseExcelMultiSheet({} as File)).rejects.toThrow('read failed');
    });
});
