/**
 * azurePipeline.ts — the client's own Azure storage + Data Factory pipeline.
 *
 * QuickInsight's server only hands out short-lived links; the browser sends the
 * file straight to the client's incoming folder, waits for their pipeline to
 * write the cleaned file, and reads it straight from Azure. The data never
 * passes through QuickInsight's server.
 */
export interface AzurePipeline {
    id: string;
    name: string;
    account: string;
    container: string;
    incoming: string;
    cleaned: string;
    routeUploads: boolean;
    /** Admins: the pipelines they added, and who uses each. */
    mine?: boolean;
    userIds?: string[];
}
export interface CleanedFile { path: string; name: string; size: number; modified: number }

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api';
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${(typeof localStorage !== 'undefined' && localStorage.getItem('qi_token')) || ''}` });

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error || `The server answered ${res.status}`);
    return body as T;
}

export const listPipelines = () => call<{ pipelines: AzurePipeline[] }>('/azure-pipelines').then(b => b.pipelines || []);
export const addPipeline = (input: Partial<AzurePipeline> & { key: string }) => call<{ pipeline: AzurePipeline }>('/azure-pipelines', { method: 'POST', body: JSON.stringify(input) }).then(b => b.pipeline);
export const savePipeline = (id: string, input: Partial<AzurePipeline> & { key?: string }) => call(`/azure-pipelines/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(input) });
export const removePipeline = (id: string) => call(`/azure-pipelines/${encodeURIComponent(id)}`, { method: 'DELETE' });
export const sharePipeline = (id: string, userIds: string[]) => call<{ userIds: string[] }>(`/azure-pipelines/${encodeURIComponent(id)}/users`, { method: 'PUT', body: JSON.stringify({ userIds }) }).then(b => b.userIds);
export const testPipeline = (id: string) => call<{ ok: boolean; message: string }>(`/azure-pipelines/${encodeURIComponent(id)}/test`, { method: 'POST' });
export const cleanedFiles = (id: string) => call<{ files: CleanedFile[] }>(`/azure-pipelines/${encodeURIComponent(id)}/files`).then(b => b.files || []);

/** Read one cleaned file straight from Azure. */
export async function openCleanedFile(pipeline: AzurePipeline, file: CleanedFile): Promise<File> {
    const { url } = await call<{ url: string }>(`/azure-pipelines/${encodeURIComponent(pipeline.id)}/download-link`, { method: 'POST', body: JSON.stringify({ path: file.path }) });
    const res = await fetch(url);
    if (!res.ok) throw new Error(azureWords(res.status, 'read the cleaned file'));
    const blob = await res.blob();
    return new File([blob], file.name, { type: blob.type || (file.name.endsWith('.csv') ? 'text/csv' : 'application/octet-stream'), lastModified: file.modified });
}

function azureWords(status: number, doing: string): string {
    if (status === 0) return `The browser could not ${doing} in Azure. The storage account must allow this website (CORS); see the setup notes.`;
    if (status === 403) return `Azure refused to ${doing}. The link may have expired; try again.`;
    return `Azure answered ${status} while trying to ${doing}.`;
}

const stem = (name: string) => name.replace(/^\d{8}-\d{6}-/, '').replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The cleaned file that came from this upload: the newest one written after it
 * was sent whose name contains the upload's name, else the only new file.
 */
export function pickCleaned(files: CleanedFile[], uploadName: string, since: number): CleanedFile | null {
    const fresh = files.filter(f => f.modified >= since - 60_000).sort((a, b) => b.modified - a.modified);
    const want = stem(uploadName);
    const named = fresh.find(f => want && stem(f.name).includes(want));
    if (named) return named;
    return fresh.length === 1 ? fresh[0] : null;
}

export interface PipelineProgress { stage: 'sending' | 'waiting' | 'opening'; message: string; elapsedMs: number }

/**
 * Send a file through the client's pipeline and return the cleaned file.
 * Throws with plain words on a problem; `signal` stops waiting.
 */
export async function runThroughPipeline(
    pipeline: AzurePipeline,
    file: File,
    onProgress: (p: PipelineProgress) => void,
    { signal, timeoutMs = 30 * 60_000, pollMs = 10_000, sleep = (ms: number) => new Promise(r => setTimeout(r, ms)) }: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<File> {
    const started = Date.now();
    onProgress({ stage: 'sending', message: `Sending ${file.name} to ${pipeline.name}'s Azure storage`, elapsedMs: 0 });
    const link = await call<{ url: string; path: string; startedAt: number }>(`/azure-pipelines/${encodeURIComponent(pipeline.id)}/upload-link`, { method: 'POST', body: JSON.stringify({ fileName: file.name }) });
    let put: Response;
    try {
        put = await fetch(link.url, { method: 'PUT', body: file, headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': file.type || 'application/octet-stream' }, signal });
    } catch (error: any) {
        if (signal?.aborted) throw new Error('Stopped.');
        throw new Error(azureWords(0, 'send the file'));
    }
    if (!put.ok) throw new Error(azureWords(put.status, 'send the file'));
    const since = link.startedAt || started;
    while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) throw new Error('Stopped.');
        onProgress({ stage: 'waiting', message: `Waiting for ${pipeline.name}'s pipeline to write the cleaned file to ${pipeline.cleaned || 'the container'}`, elapsedMs: Date.now() - started });
        await sleep(pollMs);
        if (signal?.aborted) throw new Error('Stopped.');
        const found = pickCleaned(await cleanedFiles(pipeline.id), file.name, since);
        if (found) {
            onProgress({ stage: 'opening', message: `Opening ${found.name}`, elapsedMs: Date.now() - started });
            return openCleanedFile(pipeline, found);
        }
    }
    throw new Error(`The pipeline has not written a cleaned file after ${Math.round(timeoutMs / 60_000)} minutes. It will show under Cleaned files when it does.`);
}

/** The pipeline this person's uploads go through, if any. */
export async function uploadPipeline(): Promise<AzurePipeline | null> {
    try {
        const all = await listPipelines();
        // An admin's own pipelines are for their clients; only shared ones route their uploads.
        return all.find(p => p.routeUploads && !p.mine) || null;
    } catch {
        return null;
    }
}
