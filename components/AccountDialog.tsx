/**
 * "Your account": change password, download everything stored about you,
 * and delete your account. The last two are the UK GDPR rights of access and
 * erasure, available without contacting anyone.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Download, KeyRound, Loader2, Trash2, X } from 'lucide-react';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';

type Section = 'password' | 'data' | 'delete';

interface Props {
    email?: string;
    onClose: () => void;
    /** Called after the account is deleted: sign out and clear this browser. */
    onDeleted: () => void | Promise<void>;
    /** Extra sections (plan and billing) rendered above the rest. */
    children?: React.ReactNode;
}

const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('qi_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
};

export function AccountDialog({ email, onClose, onDeleted, children }: Props) {
    const [section, setSection] = useState<Section | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState('');
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [again, setAgain] = useState('');
    const [deletePassword, setDeletePassword] = useState('');
    const [deleteWord, setDeleteWord] = useState('');
    const closeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => { closeRef.current?.focus(); }, []);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [busy, onClose]);

    const open = (next: Section) => { setSection(section === next ? null : next); setError(''); setDone(''); };

    const changePassword = async () => {
        setError(''); setDone('');
        if (next.length < 8) { setError('The new password needs at least 8 characters'); return; }
        if (next !== again) { setError('The two new passwords do not match'); return; }
        if (next === current) { setError('Choose a password different from the current one'); return; }
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/change-password`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ currentPassword: current, newPassword: next }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) setError(data.error || 'Could not change the password');
            else {
                if (data.token) localStorage.setItem('qi_token', data.token);
                setDone('Password changed. You stay signed in here; other devices are signed out.');
                setCurrent(''); setNext(''); setAgain('');
            }
        } catch { setError('Could not reach QuickInsight. Check your connection.'); }
        setBusy(false);
    };

    const downloadData = async () => {
        setError(''); setDone(''); setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/account-export`, { headers: authHeaders() });
            if (!res.ok) { const data = await res.json().catch(() => ({})); setError(data.error || 'Could not prepare your data'); }
            else {
                const blob = new Blob([JSON.stringify(await res.json(), null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'quickinsight-account-data.json';
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setDone('Downloaded. Your uploaded files are not in it: they never leave this browser.');
            }
        } catch { setError('Could not reach QuickInsight. Check your connection.'); }
        setBusy(false);
    };

    const deleteAccount = async () => {
        setError(''); setDone('');
        if (deleteWord !== 'DELETE') { setError('Type DELETE in capitals to confirm'); return; }
        setBusy(true);
        try {
            const res = await fetch(`${API_BASE}/auth/delete-account`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ password: deletePassword, confirm: 'DELETE' }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.success) { setError(data.error || 'Could not delete the account'); setBusy(false); return; }
            await onDeleted();
        } catch { setError('Could not reach QuickInsight. Check your connection.'); setBusy(false); }
    };

    const row = (key: Section, icon: React.ReactNode, title: string, hint: string, danger = false) => (
        <button type="button" className={`qi-account-row${danger ? ' is-danger' : ''}`} aria-expanded={section === key} onClick={() => open(key)}>
            <span className="qi-account-row-icon" aria-hidden>{icon}</span>
            <span className="qi-account-row-text"><strong>{title}</strong><span>{hint}</span></span>
        </button>
    );

    return (
        <div className="qi-account-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
            <div className="qi-account" role="dialog" aria-modal="true" aria-labelledby="qi-account-title">
                <header className="qi-account-head">
                    <div>
                        <h2 id="qi-account-title">Your account</h2>
                        {email && <p>{email}</p>}
                    </div>
                    <button ref={closeRef} type="button" className="qi-account-close" aria-label="Close" onClick={onClose} disabled={busy}><X className="h-4 w-4" /></button>
                </header>

                {children}

                {row('password', <KeyRound className="h-4 w-4" />, 'Change password', 'Signs out your other devices')}
                {section === 'password' && (
                    <div className="qi-account-panel">
                        <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
                        <label>New password (at least 8 characters)<input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} /></label>
                        <label>New password again<input type="password" autoComplete="new-password" value={again} onChange={e => setAgain(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void changePassword(); }} /></label>
                        <button type="button" className="qi-account-primary" disabled={busy || !current || !next} onClick={() => void changePassword()}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />} Save new password
                        </button>
                    </div>
                )}

                {row('data', <Download className="h-4 w-4" />, 'Download my data', 'Everything QuickInsight stores about your account')}
                {section === 'data' && (
                    <div className="qi-account-panel">
                        <p>Your profile, saved dashboards, AI usage and activity, as one file. Your uploaded files are not included: they stay in this browser and never reach our server.</p>
                        <button type="button" className="qi-account-primary" disabled={busy} onClick={() => void downloadData()}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Download
                        </button>
                    </div>
                )}

                {row('delete', <Trash2 className="h-4 w-4" />, 'Delete my account', 'Permanently, with everything stored with it', true)}
                {section === 'delete' && (
                    <div className="qi-account-panel">
                        <p className="qi-account-warn"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> This deletes your account, saved dashboards and usage history from our server, and your files from this browser. It can't be undone.</p>
                        <label>Your password<input type="password" autoComplete="current-password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)} /></label>
                        <label>Type DELETE to confirm<input type="text" value={deleteWord} onChange={e => setDeleteWord(e.target.value)} autoComplete="off" /></label>
                        <button type="button" className="qi-account-danger" disabled={busy || !deletePassword || deleteWord !== 'DELETE'} onClick={() => void deleteAccount()}>
                            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />} Delete my account
                        </button>
                    </div>
                )}

                {error && <p className="qi-account-error" role="alert"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {error}</p>}
                {done && <p className="qi-account-done" role="status"><Check className="h-4 w-4 shrink-0" aria-hidden /> {done}</p>}
            </div>
        </div>
    );
}
