/**
 * The AI layer of the column dictionary: one call at upload (or the first
 * time a dataset is opened without one) that writes each column's meaning,
 * which way is good, what a negative means and the words people use for it.
 * It is sent names, roles and formulas only — never a value from the data.
 */
import type { Dataset, DatasetDomainProfile } from '../types';
import { fetchWithFallback, PRIMARY_MODEL } from './ai-sql/modelConfig';
import { applyDictionary, dictionaryRequest } from './columnDictionary';

const SYSTEM = 'You write a plain-English data dictionary for a small-business owner. You only ever see column names, roles and formulas, never the data. Reply with JSON only.';

function readJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** An empty profile for a dataset that has none yet. */
export const blankProfile = (): DatasetDomainProfile => ({ domain: 'General', summary: '', confidence: 0, columnSemantics: {}, detectedAt: Date.now() } as DatasetDomainProfile);

/** The AI's meanings for this dataset's columns (merge them with applyDictionary), or null when it could not be reached. */
export async function askColumnMeanings(dataset: Dataset): Promise<unknown | null> {
    try {
        const reply = await fetchWithFallback([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: dictionaryRequest(dataset) },
        ], { model: PRIMARY_MODEL, temperature: 0, max_tokens: 2400, timeout: 45_000 });
        return readJson(String(reply.data?.choices?.[0]?.message?.content || '')) || { columns: {} };
    } catch (error) {
        console.warn('[Column meanings] could not be written now; rules and earlier settings still apply', error);
        return null;
    }
}

/** The profile with the meanings written in, or null when the AI could not be reached. */
export async function writeColumnMeanings(dataset: Dataset): Promise<DatasetDomainProfile | null> {
    const profile: DatasetDomainProfile = dataset.domainProfile || blankProfile();
    try {
        const reply = await fetchWithFallback([
            { role: 'system', content: SYSTEM },
            { role: 'user', content: dictionaryRequest(dataset) },
        ], { model: PRIMARY_MODEL, temperature: 0, max_tokens: 2400, timeout: 45_000 });
        const parsed = readJson(String(reply.data?.choices?.[0]?.message?.content || ''));
        if (!parsed) return { ...profile, meaningsVersion: 1 };
        return applyDictionary(profile, parsed, dataset);
    } catch (error) {
        console.warn('[Column meanings] could not be written now; rules and earlier settings still apply', error);
        return null;
    }
}
