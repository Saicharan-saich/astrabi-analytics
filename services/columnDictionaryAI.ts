/**
 * The AI layer of the column dictionary: one call at upload (and the first
 * time each dataset is opened in a session) that writes each column's meaning,
 * which way is good, what a negative means and the words people use for it,
 * checked against the web. It is sent names, roles and formulas only — never
 * a value from the data — and those are all it can search with.
 */
import type { Dataset, DatasetDomainProfile } from '../types';
import { fetchWithFallback, PRIMARY_MODEL } from './ai-sql/modelConfig';
import { applyDictionary, dictionaryRequest, keepSessionColumnContext, sessionColumnContext } from './columnDictionary';

const SYSTEM_ONLINE = 'You write a plain-English data dictionary for a small-business owner, and you check it against the web before answering. You only ever see column names, roles and formulas, never the data. Reply with JSON only.';
const SYSTEM = 'You write a plain-English data dictionary for a small-business owner. You only ever see column names, roles and formulas, never the data. Reply with JSON only.';

function readJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

/** An empty profile for a dataset that has none yet. */
export const blankProfile = (): DatasetDomainProfile => ({ domain: 'General', summary: '', confidence: 0, columnSemantics: {}, detectedAt: Date.now() } as DatasetDomainProfile);

/** Pages the web search returned, from the reply's citations. */
function citedPages(message: any): { title: string; url: string }[] {
    const seen = new Set<string>();
    const out: { title: string; url: string }[] = [];
    for (const note of Array.isArray(message?.annotations) ? message.annotations : []) {
        const cite = note?.type === 'url_citation' ? (note.url_citation || note) : null;
        if (!cite || typeof cite.url !== 'string' || seen.has(cite.url)) continue;
        seen.add(cite.url);
        out.push({ title: String(cite.title || '').slice(0, 120), url: cite.url });
    }
    return out.slice(0, 12);
}

async function ask(dataset: Dataset, online: boolean): Promise<Record<string, unknown> | null> {
    const reply = await fetchWithFallback([
        { role: 'system', content: online ? SYSTEM_ONLINE : SYSTEM },
        { role: 'user', content: dictionaryRequest(dataset, { online }) },
    ], online
        ? { model: PRIMARY_MODEL, temperature: 0, max_tokens: 4000, timeout: 120_000, webSearch: true }
        : { model: PRIMARY_MODEL, temperature: 0, max_tokens: 2400, timeout: 45_000 });
    const message = reply.data?.choices?.[0]?.message;
    const parsed = readJson(String(message?.content || '')) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    return online ? { ...parsed, checkedOnline: true, sources: citedPages(message) } : { ...parsed, checkedOnline: false };
}

/**
 * The AI's meanings for this dataset's columns (merge them with
 * applyDictionary), or null when it could not be reached.
 *
 * The AI is sent the column names, roles and formulas and checks them
 * against the web: what kind of file has these columns, and what each name
 * means there. What it finds is kept on this device until the user logs out,
 * so the same kind of file is not looked up twice in a session. If the online
 * check cannot run, the AI answers from what it knows (not marked as checked).
 */
export async function askColumnMeanings(dataset: Dataset): Promise<unknown | null> {
    const names = dataset.columns.map(c => c.name);
    const kept = sessionColumnContext(names);
    if (kept) return kept;
    try {
        const found = await ask(dataset, true);
        if (found) { keepSessionColumnContext(names, found); return found; }
    } catch (error) {
        console.warn('[Column meanings] the online check could not run; answering from what the AI knows', error);
    }
    try {
        return (await ask(dataset, false)) || { columns: {}, checkedOnline: false };
    } catch (error) {
        console.warn('[Column meanings] could not be written now; rules and earlier settings still apply', error);
        return null;
    }
}

/** The profile with the meanings written in, or null when the AI could not be reached. */
export async function writeColumnMeanings(dataset: Dataset): Promise<DatasetDomainProfile | null> {
    const profile: DatasetDomainProfile = dataset.domainProfile || blankProfile();
    const reply = await askColumnMeanings(dataset);
    return reply ? applyDictionary(profile, reply, dataset) : null;
}
