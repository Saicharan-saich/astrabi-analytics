/**
 * The plan part of "Your account": which plan, how much of the free trial is
 * left, AI questions used today, and the way to pay or manage billing
 * (Stripe Checkout and the Stripe billing portal). Plans and prices come from
 * backend/plans.json, the same file the server uses.
 */
import { useEffect, useState } from 'react';
import { CreditCard, ExternalLink, Loader2, Sparkles } from 'lucide-react';
import plansFile from '../backend/plans.json';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';

interface Status {
    plan: { id: string; name: string };
    status: string;
    trialEndsAt: string | null;
    periodEnd: string | null;
    hasBillingAccount: boolean;
    aiQuestions: { usedToday: number; limit: number | null };
    paymentsEnabled: boolean;
    limitsEnforced: boolean;
}

const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('qi_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
};

const daysLeft = (iso: string | null) => iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0;

export function PlanSection({ notice }: { notice?: string }) {
    const [status, setStatus] = useState<Status | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        fetch(`${API_BASE}/billing/status`, { headers: authHeaders() })
            .then(res => res.json().then(data => ({ ok: res.ok, data })))
            .then(({ ok, data }) => { if (!alive) return; if (ok && data.success) setStatus(data); else setError(data.error || 'Could not read your plan'); })
            .catch(() => { if (alive) setError('Could not reach QuickInsight to read your plan.'); });
        return () => { alive = false; };
    }, []);

    const go = async (path: 'checkout' | 'portal', plan?: string) => {
        setBusy(plan || path); setError('');
        try {
            const res = await fetch(`${API_BASE}/billing/${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() }, body: JSON.stringify(plan ? { plan } : {}),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.url) { setError(data.error || 'The payment page could not be opened.'); setBusy(null); return; }
            window.location.assign(data.url);
        } catch { setError('Could not reach QuickInsight. Check your connection.'); setBusy(null); }
    };

    const paid = plansFile.plans.filter(plan => plan.id !== 'free' && (plan as { available?: boolean }).available !== false);
    const onTrial = status?.status === 'trial';
    const paying = status && ['active', 'past_due', 'trialing'].includes(status.status);
    const limit = status?.aiQuestions.limit;

    return (
        <section className="qi-plan" aria-labelledby="qi-plan-title">
            <div className="qi-plan-head">
                <span className="qi-account-row-icon" aria-hidden><CreditCard className="h-4 w-4" /></span>
                <div>
                    <h3 id="qi-plan-title">{status ? `${status.plan.name} plan` : 'Your plan'}</h3>
                    {status && (
                        <p>
                            {onTrial ? `Free trial: ${daysLeft(status.trialEndsAt)} day${daysLeft(status.trialEndsAt) === 1 ? '' : 's'} left.`
                                : status.status === 'trial_ended' ? 'Your free trial has ended.'
                                    : status.status === 'past_due' ? 'Your last payment failed. Update your card to keep your plan.'
                                        : paying && status.periodEnd ? `Renews on ${new Date(status.periodEnd).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`
                                            : ''}
                            {' '}AI questions today: {status.aiQuestions.usedToday}{limit === null || limit === undefined ? '' : ` of ${limit}`}.
                        </p>
                    )}
                    {!status && !error && <p><Loader2 className="inline h-3.5 w-3.5 animate-spin" aria-hidden /> Reading your plan…</p>}
                </div>
            </div>
            {notice && <p className="qi-account-done" role="status">{notice}</p>}
            {status && !status.paymentsEnabled && (
                <p className="qi-plan-note">Card payments aren't switched on yet. Your current limits stay as they are until they are.</p>
            )}
            {status && status.paymentsEnabled && (
                <div className="qi-plan-actions">
                    {(!paying || status.plan.id === 'free') && paid.map(plan => (
                        <button key={plan.id} type="button" className="qi-account-primary" disabled={Boolean(busy)} onClick={() => void go('checkout', plan.id)}>
                            {busy === plan.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Sparkles className="h-4 w-4" aria-hidden />}
                            Choose {plan.name}{plan.placeholder ? '' : ` · ${plan.price} ${plan.period}`}
                        </button>
                    ))}
                    {status.hasBillingAccount && (
                        <button type="button" className="qi-plan-secondary" disabled={Boolean(busy)} onClick={() => void go('portal')}>
                            {busy === 'portal' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />}
                            Manage billing and invoices
                        </button>
                    )}
                </div>
            )}
            {error && <p className="qi-account-error" role="alert">{error}</p>}
        </section>
    );
}
