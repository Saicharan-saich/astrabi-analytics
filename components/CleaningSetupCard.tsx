import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, Download, FileText, Loader2, Pencil, Puzzle, RefreshCw, Trash2, Upload, Users } from 'lucide-react';
import type { AppliedSetup, CleaningSetup, Dataset } from '../types';
import { useSetupStore } from '../store/useSetupStore';
import { buildSetup, choicesDiffer, describeSetup, headersOf, pickSetup, readSetupFile, setupFile } from '../utils/cleaningSetups';
import { SetupHandover } from './SetupHandover';
import { useAuthStore } from '../store/useAuthStore';
import { shareSetup } from '../services/setupSync';

const ADMIN_API = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api').replace(/\/api$/, '');
interface Person { id: string; name: string; email: string; role: string }

/**
 * Choose which accounts receive a setup: typically the client's own logins.
 * They get it on their next sign-in, read-only, and it cleans their uploads.
 */
function SharePicker({ setup, onClose }: { setup: CleaningSetup; onClose: () => void }) {
    const me = useAuthStore(state => state.currentUser);
    const current = useSetupStore(state => state.shares[setup.id]) || [];
    const [people, setPeople] = useState<Person[] | null>(null);
    const [picked, setPicked] = useState<string[]>(current);
    const [filter, setFilter] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        fetch(`${ADMIN_API}/api/admin/users`, { headers: { Authorization: `Bearer ${localStorage.getItem('qi_token') || ''}` } })
            .then(res => res.json())
            .then(data => {
                if (!live) return;
                const list: Person[] = Array.isArray(data?.users) ? data.users.filter((u: any) => u.id !== me?.id && u.is_active !== false).map((u: any) => ({ id: u.id, name: u.name, email: u.email, role: String(u.role || '') })) : [];
                setPeople(list);
            })
            .catch(() => { if (live) { setPeople([]); setMessage('Could not load the accounts. Check the connection and try again.'); } });
        return () => { live = false; };
    }, [me?.id]);
    const shown = (people || []).filter(p => !filter.trim() || `${p.name} ${p.email}`.toLowerCase().includes(filter.trim().toLowerCase()));
    const toggle = (id: string) => setPicked(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
    const save = async () => {
        setBusy(true); setMessage(null);
        const result = await shareSetup(setup.id, picked, me?.id);
        setBusy(false);
        if (result.ok) onClose(); else setMessage(result.message || 'Could not share the setup.');
    };
    const changed = picked.length !== current.length || picked.some(id => !current.includes(id));
    return (
        <div className="qi-share" role="group" aria-label={`Share ${setup.name}`}>
            <p className="qi-share-intro">Pick the accounts that should clean their files with this setup, usually the client's own logins. They get it the next time they sign in, can't change it, and it never holds their rows.</p>
            {people === null ? <p className="qi-setup-meta"><Loader2 className="inline h-3 w-3 animate-spin" aria-hidden /> Loading accounts…</p> : (
                <>
                    {people.length > 6 && <input className="qi-setup-input" placeholder="Find by name or email" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Find an account" />}
                    {people.length ? (
                        <ul className="qi-share-list">
                            {shown.map(p => (
                                <li key={p.id}>
                                    <label>
                                        <input type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} />
                                        <span><strong>{p.name}</strong> <em>{p.email}</em></span>
                                        <span className="qi-share-role">{p.role.toLowerCase()}</span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    ) : <p className="qi-setup-meta">No other accounts yet. Create the client's login in Manage Users first.</p>}
                </>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="qi-review-apply" disabled={busy || !changed} onClick={save}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Users className="h-3.5 w-3.5" aria-hidden />} {picked.length ? `Share with ${picked.length} account${picked.length === 1 ? '' : 's'}` : 'Stop sharing'}</button>
                <button type="button" className="qi-chk-undo" onClick={onClose}>Cancel</button>
                {message && <span className="qi-setup-meta" role="alert">{message}</span>}
            </div>
        </div>
    );
}

/**
 * Saved cleaning setups, on the Cleaning tab.
 *
 * The idea: clean a client's file once, together, and save the choices. Every
 * later file with the same columns is then cleaned the same way, automatically
 * and in the browser. This card saves a setup, says which setup cleaned the
 * data and how the file differed, and manages the saved setups.
 */

interface Props {
    dataset: Dataset;
    onApplySetup?: (setup: CleaningSetup) => void;
    onCleanWithoutSetup?: () => void;
    onSetupSaved?: (applied: AppliedSetup) => void;
    pending?: string | null;
}

const fileStem = (name: string) => name.replace(/\.(csv|xlsx?|json|parquet)$/i, '').replace(/[_-]+/g, ' ').trim();
const day = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Where the setups are kept, and whether the account is up to date. */
function SyncLine() {
    const sync = useSetupStore(state => state.sync);
    const ago = (ms?: number) => {
        if (!ms) return '';
        const min = Math.round((Date.now() - ms) / 60000);
        return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : day(ms);
    };
    const words = sync.status === 'synced' ? `Kept with your account, so they are there on any computer you sign in on · up to date ${ago(sync.at)}`
        : sync.status === 'syncing' ? 'Saving to your account…'
            : sync.status === 'offline' ? (sync.message || 'Could not reach your account; your setups are safe in this browser and will sync later.')
                : 'Kept in this browser only. Sign in to keep them with your account.';
    return <span className={`qi-setup-sync is-${sync.status}`} role="status">{sync.status === 'syncing' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <span className="qi-setup-dot" aria-hidden />}{words}</span>;
}

function SetupList({ setups, current }: { setups: CleaningSetup[]; current?: string }) {
    const { renameSetup, deleteSetup, addSetups } = useSetupStore();
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [confirm, setConfirm] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [handover, setHandover] = useState<CleaningSetup | null>(null);
    const [sharing, setSharing] = useState<string | null>(null);
    const shares = useSetupStore(state => state.shares);
    const fileInput = useRef<HTMLInputElement>(null);

    const download = () => {
        const blob = new Blob([setupFile(setups)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quickinsight-cleaning-setups-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const load = async (file?: File) => {
        if (!file) return;
        const { setups: loaded, error } = readSetupFile(await file.text());
        if (error) { setMessage(error); return; }
        addSetups(loaded);
        setMessage(`Loaded ${loaded.length} setup${loaded.length === 1 ? '' : 's'}.`);
    };

    return (
        <div className="qi-setup-manage">
            {setups.length ? (
                <ul className="qi-setup-list">
                    {setups.map(setup => (
                        <li key={setup.id} className={setup.id === current ? 'is-current' : ''}>
                            <div className="min-w-0 flex-1">
                                {editing === setup.id ? (
                                    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); renameSetup(setup.id, draft); setEditing(null); }}>
                                        <input className="qi-setup-input" value={draft} onChange={event => setDraft(event.target.value)} aria-label="Setup name" autoFocus />
                                        <button type="submit" className="qi-chk-undo">Save</button>
                                        <button type="button" className="qi-chk-undo" onClick={() => setEditing(null)}>Cancel</button>
                                    </form>
                                ) : (
                                    <strong>{setup.name}{setup.id === current && <span className="qi-setup-tag">This data</span>}</strong>
                                )}
                                <span>{describeSetup(setup)}</span>
                                <span className="qi-setup-meta">{setup.columns.length} columns · saved {day(setup.updatedAt)}{setup.timesUsed ? ` · used ${setup.timesUsed} time${setup.timesUsed === 1 ? '' : 's'}, last on ${day(setup.lastUsedAt)}` : ' · not used yet'}{shares[setup.id]?.length ? ` · shared with ${shares[setup.id].length} account${shares[setup.id].length === 1 ? '' : 's'}` : ''}</span>
                                {sharing === setup.id && <SharePicker setup={setup} onClose={() => setSharing(null)} />}
                            </div>
                            {editing !== setup.id && (
                                <div className="qi-setup-actions">
                                    <button type="button" className="qi-chk-undo" onClick={() => setSharing(sharing === setup.id ? null : setup.id)} aria-expanded={sharing === setup.id} aria-label={`Share ${setup.name} with accounts`}><Users className="h-3 w-3" aria-hidden /> Share</button>
                                    <button type="button" className="qi-chk-undo" onClick={() => setHandover(setup)} aria-label={`Handover page for ${setup.name}`}><FileText className="h-3 w-3" aria-hidden /> Handover page</button>
                                    <button type="button" className="qi-chk-undo" onClick={() => { setEditing(setup.id); setDraft(setup.name); }} aria-label={`Rename ${setup.name}`}><Pencil className="h-3 w-3" aria-hidden /> Rename</button>
                                    {confirm === setup.id ? (
                                        <button type="button" className="qi-chk-undo is-danger" onClick={() => { deleteSetup(setup.id); setConfirm(null); }}><Trash2 className="h-3 w-3" aria-hidden /> Delete for good</button>
                                    ) : (
                                        <button type="button" className="qi-chk-undo" onClick={() => setConfirm(setup.id)} aria-label={`Delete ${setup.name}`}><Trash2 className="h-3 w-3" aria-hidden /> Delete</button>
                                    )}
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            ) : <p className="qi-chk-group-sub">No setups saved yet.</p>}
            <div className="qi-setup-file">
                {setups.length > 0 && <button type="button" className="qi-chk-undo" onClick={download}><Download className="h-3 w-3" aria-hidden /> Download setup file</button>}
                <button type="button" className="qi-chk-undo" onClick={() => fileInput.current?.click()}><Upload className="h-3 w-3" aria-hidden /> Load a setup file</button>
                <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" aria-label="Setup file" onChange={event => { load(event.target.files?.[0]); event.target.value = ''; }} />
                <span className="qi-setup-meta">Setups hold cleaning choices and column names, never your rows.</span>
                <SyncLine />
            </div>
            {message && <p className="qi-setup-meta" role="status">{message}</p>}
            {handover && <SetupHandover setup={setups.find(s => s.id === handover.id) || handover} onClose={() => setHandover(null)} />}
        </div>
    );
}

export const CleaningSetupCard: React.FC<Props> = ({ dataset, onApplySetup, onCleanWithoutSetup, onSetupSaved, pending = null }) => {
    const setups = useSetupStore(state => state.setups);
    const saveSetup = useSetupStore(state => state.saveSetup);
    const [name, setName] = useState(() => fileStem(dataset.name));
    const [manage, setManage] = useState(false);
    const [showHandover, setShowHandover] = useState(false);
    const busy = Boolean(pending);
    const applied = dataset.cleaningSetup;
    const setup = applied ? setups.find(s => s.id === applied.id) : undefined;
    // A setup that fits this data, for data cleaned before the setup existed.
    const suggestion = useMemo(() => (applied ? null : pickSetup(headersOf(dataset.rawRows?.length ? dataset.rawRows : dataset.rows), setups)), [applied, dataset.rawRows, dataset.rows, setups]);
    const changed = setup ? choicesDiffer(dataset, setup) : false;
    const serious = (applied?.changes || []).filter(c => c.serious);

    const save = (existing?: CleaningSetup) => {
        const next = buildSetup(dataset, existing ? existing.name : name, existing);
        saveSetup(next);
        onSetupSaved?.({ id: next.id, name: next.name, match: 'exact', appliedAt: Date.now(), changes: [], savedHere: existing ? Boolean(applied?.savedHere) : true });
    };

    return (
        <section className="qi-setup" aria-label="Saved cleaning setup">
            {applied ? (
                <div className={`qi-setup-head ${serious.length ? 'is-attention' : 'is-ok'}`}>
                    {serious.length ? <AlertCircle className="h-5 w-5" aria-hidden /> : <Puzzle className="h-5 w-5" aria-hidden />}
                    <div className="min-w-0 flex-1">
                        <h3>{applied.savedHere ? `Saved as the setup '${applied.name}'` : `Cleaned with your saved setup '${applied.name}'`}</h3>
                        <p>
                            {setup ? `${describeSetup(setup)}.` : 'This setup has since been deleted.'}{' '}
                            {applied.savedHere
                                ? 'The next file with these columns will be cleaned the same way, automatically.'
                                : applied.match === 'exact' ? 'This file has the same columns as the one it was made for.' : 'Most of this file\'s columns match the one it was made for.'}
                        </p>
                        {applied.changes.length > 0 && (
                            <div className="qi-setup-changes">
                                <strong>{serious.length ? `${serious.length} difference${serious.length === 1 ? '' : 's'} could change the numbers` : 'Small differences from the file it was made for'}</strong>
                                <ul>{applied.changes.map(change => <li key={`${change.kind}:${change.column}`} className={change.serious ? 'is-serious' : ''}>{change.text}</li>)}</ul>
                            </div>
                        )}
                        <div className="qi-setup-buttons">
                            {setup && (
                                <button type="button" className="qi-chk-undo" onClick={() => setShowHandover(true)}>
                                    <FileText className="h-3 w-3" aria-hidden /> Handover page
                                </button>
                            )}
                            {setup && changed && (
                                <button type="button" className="qi-chk-undo" onClick={() => save(setup)} disabled={busy}>
                                    <RefreshCw className="h-3 w-3" aria-hidden /> Update the setup with your latest choices
                                </button>
                            )}
                            {!applied.savedHere && onCleanWithoutSetup && (
                                <button type="button" className="qi-chk-undo" onClick={onCleanWithoutSetup} disabled={busy}>
                                    {pending === '__setup__' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : null} Clean without it
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            ) : suggestion && onApplySetup ? (
                <div className="qi-setup-head is-attention">
                    <Puzzle className="h-5 w-5" aria-hidden />
                    <div className="min-w-0 flex-1">
                        <h3>This file looks like '{suggestion.setup.name}'</h3>
                        <p>{describeSetup(suggestion.setup)}. {suggestion.match === 'exact' ? 'It has the same columns.' : 'Most of its columns match.'} Clean it with that setup so it matches the earlier files?</p>
                        <div className="qi-setup-buttons">
                            <button type="button" className="qi-review-apply" onClick={() => onApplySetup(suggestion.setup)} disabled={busy}>
                                {pending === '__setup__' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />} Clean with this setup
                            </button>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="qi-setup-head">
                    <Puzzle className="h-5 w-5" aria-hidden />
                    <div className="min-w-0 flex-1">
                        <h3>Will this file come again?</h3>
                        <p>Save these cleaning steps as a setup. Every later file with the same columns is then cleaned exactly the same way, automatically, so this month's numbers match last month's.</p>
                        <form className="qi-setup-save" onSubmit={event => { event.preventDefault(); if (name.trim()) save(); }}>
                            <label htmlFor="qi-setup-name" className="qi-setup-meta">Name it for the client and the file</label>
                            <div className="flex flex-wrap gap-2">
                                <input id="qi-setup-name" className="qi-setup-input" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Acme · monthly sales export" />
                                <button type="submit" className="qi-review-apply" disabled={!name.trim() || busy}><CheckCircle2 className="h-4 w-4" aria-hidden /> Save as a setup</button>
                            </div>
                        </form>
                        <p className="qi-setup-meta">Saved: your steps, checks, blank-cell decisions, review decisions, undone steps and column kinds.</p>
                    </div>
                </div>
            )}
            <button type="button" className="qi-chk-more" aria-expanded={manage} onClick={() => setManage(v => !v)}>
                <ChevronDown className={`h-3.5 w-3.5 ${manage ? 'rotate-180' : ''}`} aria-hidden /> {manage ? 'Hide saved setups' : `Saved setups (${setups.length})`}
            </button>
            {manage && <SetupList setups={setups} current={applied?.id} />}
            {showHandover && setup && <SetupHandover setup={setup} onClose={() => setShowHandover(false)} />}
        </section>
    );
};
