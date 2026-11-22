import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, Cloud, FolderOpen, Loader2, Pencil, Plus, RefreshCw, Trash2, Users, XCircle } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';
import { canUseCleaning } from '../utils/cleaningAccess';
import { AccountPicker } from './AccountPicker';
import {
    addPipeline, cleanedFiles, listPipelines, openCleanedFile, removePipeline, savePipeline, sharePipeline, testPipeline,
    type AzurePipeline, type CleanedFile,
} from '../services/azurePipeline';

/**
 * Azure data pipelines on the Data Source page.
 * Admins add a client's Azure storage (the container their Data Factory
 * pipeline reads from and writes to) and choose which accounts use it.
 * Those accounts see the cleaned files and can open them; their uploads go
 * through the pipeline when that is switched on.
 */
const size = (bytes: number) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function CleanedFiles({ pipeline, onOpen }: { pipeline: AzurePipeline; onOpen: (file: File) => void }) {
    const [files, setFiles] = useState<CleanedFile[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [opening, setOpening] = useState<string | null>(null);
    const load = useCallback(() => {
        setError(null);
        cleanedFiles(pipeline.id).then(setFiles).catch(e => { setFiles([]); setError(e.message); });
    }, [pipeline.id]);
    useEffect(() => { load(); }, [load]);
    const open = async (f: CleanedFile) => {
        setOpening(f.path); setError(null);
        try { onOpen(await openCleanedFile(pipeline, f)); } catch (e: any) { setError(e.message); } finally { setOpening(null); }
    };
    return (
        <div className="qi-pipe-files">
            <div className="qi-pipe-files-head">
                <strong>Cleaned files</strong>
                <span>in {pipeline.container}/{pipeline.cleaned}</span>
                <button type="button" className="qi-chk-undo" onClick={load} aria-label={`Refresh cleaned files for ${pipeline.name}`}><RefreshCw className="h-3 w-3" aria-hidden /> Refresh</button>
            </div>
            {files === null ? <p className="qi-setup-meta"><Loader2 className="inline h-3 w-3 animate-spin" aria-hidden /> Looking in Azure…</p>
                : files.length ? (
                    <ul className="qi-pipe-list">
                        {files.slice(0, 12).map(f => (
                            <li key={f.path}>
                                <span className="min-w-0"><strong>{f.name}</strong><em>{size(f.size)} · {when(f.modified)}</em></span>
                                <button type="button" className="qi-chk-undo" disabled={Boolean(opening)} onClick={() => open(f)} aria-label={`Open ${f.name}`}>
                                    {opening === f.path ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <FolderOpen className="h-3 w-3" aria-hidden />} Open
                                </button>
                            </li>
                        ))}
                    </ul>
                ) : !error && <p className="qi-setup-meta">No cleaned CSV or Excel files yet. When the pipeline writes one, it appears here.</p>}
            {error && <p className="qi-pipe-error" role="alert"><XCircle className="h-3.5 w-3.5" aria-hidden /> {error}</p>}
        </div>
    );
}

const EMPTY = { name: '', account: '', container: '', incoming: 'incoming/', cleaned: 'cleaned/', key: '', routeUploads: true };

function PipelineForm({ initial, onDone, onCancel }: { initial?: AzurePipeline; onDone: () => void; onCancel: () => void }) {
    const [form, setForm] = useState(initial ? { ...EMPTY, ...initial, key: '' } : EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        setBusy(true); setError(null);
        try {
            const body = { name: form.name, account: form.account, container: form.container, incoming: form.incoming, cleaned: form.cleaned, routeUploads: form.routeUploads, ...(form.key ? { key: form.key } : {}) };
            if (initial) await savePipeline(initial.id, body); else await addPipeline({ ...body, key: form.key });
            onDone();
        } catch (err: any) { setError(err.message); } finally { setBusy(false); }
    };
    const field = (label: string, key: keyof typeof form, hint?: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
        <label className="qi-pipe-field">
            <span>{label}</span>
            <input className="qi-setup-input" value={String(form[key] ?? '')} onChange={e => set({ [key]: e.target.value } as any)} aria-label={label} {...extra} />
            {hint && <em>{hint}</em>}
        </label>
    );
    return (
        <form className="qi-pipe-form" onSubmit={submit} aria-label={initial ? `Edit ${initial.name}` : 'Add an Azure data pipeline'}>
            {field('Name', 'name', 'Usually the client, e.g. Acme Ltd', { required: true, placeholder: 'Acme Ltd' })}
            <div className="qi-pipe-row">
                {field('Storage account', 'account', 'As in acmedata.blob.core.windows.net', { required: true, placeholder: 'acmedata', autoComplete: 'off' })}
                {field('Container', 'container', undefined, { required: true, placeholder: 'sales' })}
            </div>
            <div className="qi-pipe-row">
                {field('Incoming folder', 'incoming', 'Where new files land and the pipeline is triggered')}
                {field('Cleaned folder', 'cleaned', 'Where the pipeline writes the cleaned file')}
            </div>
            {field(initial ? 'Access key (leave empty to keep the current one)' : 'Access key', 'key', 'key1 or key2 from the storage account’s Access keys. Kept encrypted on the server; never shown again or sent to a browser.', { type: 'password', required: !initial, autoComplete: 'new-password' })}
            <label className="qi-pipe-check">
                <input type="checkbox" checked={form.routeUploads} onChange={e => set({ routeUploads: e.target.checked })} />
                <span>Send uploads from the accounts it is shared with through this pipeline first</span>
            </label>
            {error && <p className="qi-pipe-error" role="alert"><XCircle className="h-3.5 w-3.5" aria-hidden /> {error}</p>}
            <div className="flex gap-2">
                <button type="submit" className="qi-review-apply" disabled={busy}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />} {initial ? 'Save' : 'Add pipeline'}</button>
                <button type="button" className="qi-chk-undo" onClick={onCancel}>Cancel</button>
            </div>
        </form>
    );
}

function SetupNotes() {
    const [open, setOpen] = useState(false);
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://quickinsight.co.uk';
    return (
        <div className="qi-pipe-notes">
            <button type="button" className="qi-chk-more" aria-expanded={open} onClick={() => setOpen(v => !v)}>
                <ChevronDown className={`h-3.5 w-3.5 ${open ? 'rotate-180' : ''}`} aria-hidden /> What to set up in Azure
            </button>
            {open && (
                <ol>
                    <li>In the client’s storage account, make one container with an incoming folder and a cleaned folder.</li>
                    <li>In Data Factory, give the pipeline a <strong>storage event trigger</strong> on “Blob created” in the incoming folder, and have it write the cleaned file to the cleaned folder as CSV, keeping the original name in it (e.g. <code>orders_nov.csv</code>).</li>
                    <li>In the storage account, under <strong>Resource sharing (CORS)</strong> for Blob service, add: allowed origin <code>{origin}</code>, methods <code>GET, PUT</code>, allowed headers <code>*</code>, exposed headers <code>*</code>, max age <code>3600</code>. This lets the browser send and read files directly, so they never pass through QuickInsight’s server.</li>
                    <li>Paste the storage account’s access key here, press <strong>Test</strong>, then <strong>Share</strong> it with the client’s accounts.</li>
                </ol>
            )}
        </div>
    );
}

export const AzurePipelinePanel: React.FC<{ onOpenFile: (file: File) => void }> = ({ onOpenFile }) => {
    const me = useAuthStore(state => state.currentUser);
    const isAdmin = canUseCleaning(me);
    const [pipelines, setPipelines] = useState<AzurePipeline[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    const [editing, setEditing] = useState<string | null>(null);
    const [sharing, setSharing] = useState<string | null>(null);
    const [tests, setTests] = useState<Record<string, { busy?: boolean; ok?: boolean; message?: string }>>({});
    const [confirm, setConfirm] = useState<string | null>(null);
    const [filesFor, setFilesFor] = useState<string | null>(null);

    const load = useCallback(() => {
        listPipelines().then(p => { setPipelines(p); setError(null); }).catch(e => { setPipelines([]); setError(e.message); });
    }, []);
    useEffect(() => { if (me) load(); }, [me, load]);
    // The client's own view opens straight onto the cleaned files.
    useEffect(() => { if (!isAdmin && pipelines?.length && !filesFor) setFilesFor(pipelines[0].id); }, [isAdmin, pipelines, filesFor]);

    if (!me || pipelines === null) return null;
    // Nothing for this account, and not an admin: say nothing.
    if (!isAdmin && !pipelines.length) return null;

    const runTest = async (id: string) => {
        setTests(t => ({ ...t, [id]: { busy: true } }));
        try { const r = await testPipeline(id); setTests(t => ({ ...t, [id]: r })); }
        catch (e: any) { setTests(t => ({ ...t, [id]: { ok: false, message: e.message } })); }
    };

    return (
        <section className="qi-pipe" aria-label="Azure data pipeline">
            <header className="qi-pipe-head">
                <Cloud className="h-5 w-5" aria-hidden />
                <div className="min-w-0">
                    <h3>Azure data pipeline</h3>
                    <p>{isAdmin
                        ? 'Connect a client’s Azure storage, where their Data Factory pipeline cleans each new file. Files go between the browser and Azure directly.'
                        : 'Your data team’s pipeline cleans your files in your Azure storage. Open a cleaned file here.'}</p>
                </div>
                {isAdmin && !adding && <button type="button" className="qi-chk-undo" onClick={() => { setAdding(true); setEditing(null); }}><Plus className="h-3 w-3" aria-hidden /> Add a pipeline</button>}
            </header>
            {error && <p className="qi-pipe-error" role="alert"><XCircle className="h-3.5 w-3.5" aria-hidden /> {error}</p>}
            {isAdmin && adding && <PipelineForm onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} />}
            {isAdmin && <SetupNotes />}
            <ul className="qi-pipe-items">
                {pipelines.map(p => (
                    <li key={p.id}>
                        {editing === p.id ? (
                            <PipelineForm initial={p} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
                        ) : (
                            <>
                                <div className="qi-pipe-item-head">
                                    <div className="min-w-0">
                                        <strong>{p.name}</strong>
                                        <span>{p.account}/{p.container} · new files in {p.incoming || '(top)'} · cleaned in {p.cleaned || '(top)'}</span>
                                        <span className="qi-setup-meta">
                                            {p.routeUploads ? 'Uploads go through this pipeline first' : 'Uploads are not sent through it'}
                                            {p.mine ? ` · shared with ${p.userIds?.length || 0} account${p.userIds?.length === 1 ? '' : 's'}` : ''}
                                        </span>
                                    </div>
                                    <div className="qi-setup-actions">
                                        <button type="button" className="qi-chk-undo" aria-expanded={filesFor === p.id} onClick={() => setFilesFor(filesFor === p.id ? null : p.id)}><FolderOpen className="h-3 w-3" aria-hidden /> Cleaned files</button>
                                        {p.mine && <>
                                            <button type="button" className="qi-chk-undo" onClick={() => runTest(p.id)} disabled={tests[p.id]?.busy}>{tests[p.id]?.busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />} Test</button>
                                            <button type="button" className="qi-chk-undo" aria-expanded={sharing === p.id} onClick={() => setSharing(sharing === p.id ? null : p.id)} aria-label={`Share ${p.name} with accounts`}><Users className="h-3 w-3" aria-hidden /> Share</button>
                                            <button type="button" className="qi-chk-undo" onClick={() => { setEditing(p.id); setAdding(false); }} aria-label={`Edit ${p.name}`}><Pencil className="h-3 w-3" aria-hidden /> Edit</button>
                                            {confirm === p.id
                                                ? <button type="button" className="qi-chk-undo is-danger" onClick={async () => { await removePipeline(p.id).catch(e => setError(e.message)); setConfirm(null); load(); }}><Trash2 className="h-3 w-3" aria-hidden /> Remove for good</button>
                                                : <button type="button" className="qi-chk-undo" onClick={() => setConfirm(p.id)} aria-label={`Remove ${p.name}`}><Trash2 className="h-3 w-3" aria-hidden /> Remove</button>}
                                        </>}
                                    </div>
                                </div>
                                {tests[p.id]?.message && (
                                    <p className={tests[p.id].ok ? 'qi-pipe-ok' : 'qi-pipe-error'} role="status">
                                        {tests[p.id].ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <XCircle className="h-3.5 w-3.5" aria-hidden />} {tests[p.id].message}
                                    </p>
                                )}
                                {sharing === p.id && (
                                    <AccountPicker
                                        label={`Share ${p.name}`}
                                        intro="Pick the client’s accounts. They can open its cleaned files, and their uploads go through it when that is switched on. They never see the access key."
                                        current={p.userIds || []}
                                        onSave={async ids => { try { await sharePipeline(p.id, ids); load(); return { ok: true }; } catch (e: any) { return { ok: false, message: e.message }; } }}
                                        onClose={() => setSharing(null)}
                                    />
                                )}
                                {filesFor === p.id && <CleanedFiles pipeline={p} onOpen={onOpenFile} />}
                            </>
                        )}
                    </li>
                ))}
            </ul>
            {isAdmin && !pipelines.length && !adding && <p className="qi-setup-meta">No pipelines yet.</p>}
        </section>
    );
};
