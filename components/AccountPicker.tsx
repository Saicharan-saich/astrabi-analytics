import React, { useEffect, useState } from 'react';
import { Loader2, Users } from 'lucide-react';
import { useAuthStore } from '../store/useAuthStore';

export const ADMIN_API = ((import.meta as any).env?.VITE_API_URL || 'http://localhost:5002/api').replace(/\/api$/, '');
interface Person { id: string; name: string; email: string; role: string }

/**
 * Choose which accounts receive something an admin set up (a cleaning setup,
 * a data pipeline): typically the client's own logins.
 */
export function AccountPicker({ label, intro, current, onSave, onClose }: {
    label: string; intro: string; current: string[];
    onSave: (userIds: string[]) => Promise<{ ok: boolean; message?: string }>; onClose: () => void;
}) {
    const me = useAuthStore(state => state.currentUser);
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
        const result = await onSave(picked);
        setBusy(false);
        if (result.ok) onClose(); else setMessage(result.message || 'Could not save who gets it.');
    };
    const changed = picked.length !== current.length || picked.some(id => !current.includes(id));
    return (
        <div className="qi-share" role="group" aria-label={label}>
            <p className="qi-share-intro">{intro}</p>
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
