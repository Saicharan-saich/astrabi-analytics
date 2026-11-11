/**
 * The column meanings are checked online at upload, with a stand-in AI:
 * the request asks for a web check and carries names and metadata only; the
 * pages the search returned become sources; what was found is reused for the
 * same kind of file until logout; and when the online check cannot run, the
 * AI answers from what it knows and nothing is marked as checked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/ai-sql/modelConfig', async (importOriginal) => {
    const original = await importOriginal<typeof import('../services/ai-sql/modelConfig')>();
    return { ...original, fetchWithFallback: vi.fn() };
});

import { fetchWithFallback } from '../services/ai-sql/modelConfig';
import { askColumnMeanings, blankProfile } from '../services/columnDictionaryAI';
import { applyDictionary, clearSessionColumnContext, columnsNeedingWord } from '../services/columnDictionary';
import { ColumnType, type Dataset } from '../types';

const rows = Array.from({ length: 60 }, (_, i) => ({ admitted: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}`, ward: ['Oak', 'Elm', 'Ash'][i % 3], LOS: 1 + (i % 9), SECRETVALUE: `patient-${i}` }));
const dataset = {
    id: 'ward', name: 'ward_stays.csv', rows, totalRows: rows.length, etlLogs: [], version: 1,
    columns: [{ name: 'admitted', type: ColumnType.DATE }, { name: 'ward', type: ColumnType.DIMENSION }, { name: 'LOS', type: ColumnType.METRIC }, { name: 'SECRETVALUE', type: ColumnType.DIMENSION }],
} as unknown as Dataset;

const found = { about: 'A hospital ward stays record.', columns: { LOS: { meaning: 'Length of stay in days.', good: 'lower', sure: true, checked: true, source: 'https://example.org/los' } } };
const reply = (content: object, annotations?: unknown[]) => ({ model: 'test', data: { choices: [{ message: { content: JSON.stringify(content), annotations } }] } });

describe('column meanings checked online at upload', () => {
    beforeEach(() => { vi.mocked(fetchWithFallback).mockReset(); clearSessionColumnContext(); });

    it('asks for a web check with names and metadata only, and keeps the pages as sources', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(found, [{ type: 'url_citation', url_citation: { url: 'https://example.org/los', title: 'Length of stay explained' } }]) as any);
        const result: any = await askColumnMeanings(dataset);
        const [messages, options] = vi.mocked(fetchWithFallback).mock.calls[0];
        expect(options).toMatchObject({ webSearch: true });
        const sent = messages.map(m => String(m.content)).join('\n');
        expect(sent).toMatch(/CHECK THIS ONLINE/);
        expect(sent).toMatch(/"LOS"/);
        expect(sent).not.toMatch(/patient-\d|Oak|Elm|Ash/);
        expect(result.checkedOnline).toBe(true);
        const profile = applyDictionary(blankProfile(), result, dataset);
        expect(profile.columnSemantics.LOS.meaningCheckedOnline).toBe(true);
        expect(profile.columnSemantics.LOS.meaningSources).toEqual([{ title: 'Length of stay explained', url: 'https://example.org/los' }]);
        expect(columnsNeedingWord({ ...dataset, domainProfile: profile } as Dataset).map(m => m.column)).not.toContain('LOS');
    });

    it('reuses what was found for the same kind of file until logout', async () => {
        vi.mocked(fetchWithFallback).mockResolvedValue(reply(found) as any);
        await askColumnMeanings(dataset);
        await askColumnMeanings({ ...dataset, id: 'ward-february', name: 'ward_stays_feb.csv' } as Dataset);
        expect(fetchWithFallback).toHaveBeenCalledTimes(1);
        clearSessionColumnContext();
        await askColumnMeanings(dataset);
        expect(fetchWithFallback).toHaveBeenCalledTimes(2);
    });

    it('answers from what the AI knows when the online check cannot run, without claiming a check', async () => {
        vi.mocked(fetchWithFallback).mockRejectedValueOnce(new Error('Online checks are switched off'));
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply({ columns: { LOS: { meaning: 'Length of stay.', sure: true, checked: true } } }) as any);
        const result: any = await askColumnMeanings(dataset);
        expect(vi.mocked(fetchWithFallback).mock.calls[1][1]).not.toHaveProperty('webSearch');
        expect(result.checkedOnline).toBe(false);
        const profile = applyDictionary(blankProfile(), result, dataset);
        expect(profile.columnSemantics.LOS.meaningCheckedOnline).toBe(false);
        // Not checked online, so the abbreviation is still asked about, and the check is tried again next time.
        expect(columnsNeedingWord({ ...dataset, domainProfile: profile } as Dataset).map(m => m.column)).toContain('LOS');
        vi.mocked(fetchWithFallback).mockResolvedValueOnce(reply(found) as any);
        expect(((await askColumnMeanings(dataset)) as any).checkedOnline).toBe(true);
    });
});
