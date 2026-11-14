/**
 * For the admin: what broke in people's browsers this week (from
 * backend/clientErrors.js), most frequent first. Reports have quoted text,
 * emails and long numbers removed before they are stored.
 */
import { useEffect, useState } from 'react';
import { Bug, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';

interface ErrorRow { message: string; kind: string; count: number; people: number; last_seen: string; release: string | null; stack: string | null }

export function AdminErrorReports({ apiBase }: { apiBase: string }) {
    const [rows, setRows] = useState<ErrorRow[] | null>(null);
    const [error, setError] = useState('');
    const [open, setOpen] = useState<number | null>(null);

    useEffect(() => {
        let alive = true;
        const token = localStorage.getItem('qi_token');
        fetch(`${apiBase}/api/admin/client-errors?days=7`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
            .then(res => res.json().then(data => ({ ok: res.ok, data })))
            .then(({ ok, data }) => { if (alive) { if (ok && data.success) setRows(data.errors); else setError(data.error || 'Could not read error reports'); } })
            .catch(() => { if (alive) setError('Could not reach the server.'); });
        return () => { alive = false; };
    }, [apiBase]);

    return (
        <section className="px-6 py-4 border-t border-white/5" aria-labelledby="qi-admin-errors">
            <h3 id="qi-admin-errors" className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                <Bug className="w-4 h-4 text-amber-400" aria-hidden /> Errors in the last 7 days
            </h3>
            {!rows && !error && <p className="text-xs text-slate-400 flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Reading reports…</p>}
            {error && <p className="text-xs text-red-300">{error}</p>}
            {rows && rows.length === 0 && <p className="text-xs text-slate-400">No errors reported.</p>}
            {rows && rows.length > 0 && (
                <ul className="space-y-1.5">
                    {rows.map((row, i) => (
                        <li key={`${row.kind}-${row.message}`} className="rounded-lg bg-white/5">
                            <button type="button" className="w-full text-left px-3 py-2 flex items-start gap-2" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                                {open === i ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-slate-400" aria-hidden /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-slate-400" aria-hidden />}
                                <span className="flex-1 min-w-0">
                                    <span className="block text-xs text-slate-100 break-words">{row.message}</span>
                                    <span className="block text-[11px] text-slate-400">
                                        {row.count} time{row.count === 1 ? '' : 's'} · {row.people} {row.people === 1 ? 'person' : 'people'} · last {new Date(row.last_seen).toLocaleString('en-GB')}{row.release ? ` · ${row.release}` : ''}
                                    </span>
                                </span>
                            </button>
                            {open === i && row.stack && <pre className="px-3 pb-3 text-[10.5px] leading-snug text-slate-300 whitespace-pre-wrap break-words">{row.stack}</pre>}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
