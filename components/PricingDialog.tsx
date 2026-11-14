/**
 * Plans and prices, shown before signing in. Everything here comes from
 * backend/plans.json (the file the server bills from), so a price or limit is
 * changed in one place. A placeholder price is shown as "Price coming soon"
 * and a plan marked "available": false as coming soon.
 */
import { useEffect, useRef } from 'react';
import { Check, Lock, ShieldCheck, X } from 'lucide-react';
import plansFile from '../backend/plans.json';

interface Plan {
    id: string;
    name: string;
    price: string;
    period: string;
    placeholder?: boolean;
    available?: boolean;
    summary: string;
    features: string[];
}

const plans = plansFile.plans as Plan[];
const trialPlan = plans.find(plan => plan.id === plansFile.trialPlan);

export function PricingDialog({ onClose, onStart }: { onClose: () => void; onStart: () => void }) {
    const closeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="qi-account-backdrop" onClick={onClose}>
            <div className="qi-account qi-pricing" role="dialog" aria-modal="true" aria-labelledby="qi-pricing-title" onClick={event => event.stopPropagation()}>
                <div className="qi-account-head">
                    <div>
                        <h2 id="qi-pricing-title">Plans and prices</h2>
                        {trialPlan && <p>Every new account starts with a {plansFile.trialDays}-day free trial of {trialPlan.name}. No card needed to start.</p>}
                    </div>
                    <button ref={closeRef} type="button" className="qi-account-close" aria-label="Close" onClick={onClose}><X className="h-4 w-4" /></button>
                </div>

                <div className="qi-pricing-grid">
                    {plans.map(plan => {
                        const soon = plan.available === false;
                        return (
                            <section key={plan.id} className={`qi-pricing-card${plan.id === plansFile.trialPlan ? ' is-featured' : ''}`} aria-labelledby={`qi-pricing-${plan.id}`}>
                                <div className="qi-pricing-name">
                                    <h3 id={`qi-pricing-${plan.id}`}>{plan.name}</h3>
                                    {soon && <span className="qi-pricing-badge">Coming soon</span>}
                                </div>
                                <p className="qi-pricing-price">
                                    {plan.placeholder ? <span className="qi-pricing-tbc">Price coming soon</span> : <>{plan.price}{plan.period && <span> {plan.period}</span>}</>}
                                </p>
                                <p className="qi-pricing-summary">{plan.summary}</p>
                                <ul>
                                    {plan.features.map(feature => <li key={feature}><Check className="h-3.5 w-3.5" aria-hidden />{feature}</li>)}
                                </ul>
                            </section>
                        );
                    })}
                </div>

                <ul className="qi-pricing-facts">
                    <li><Lock className="h-3.5 w-3.5" aria-hidden />Your files are read in your browser and are not uploaded to us.</li>
                    <li><ShieldCheck className="h-3.5 w-3.5" aria-hidden />The AI sees your question, column names and summaries, not your rows.</li>
                    <li><Check className="h-3.5 w-3.5" aria-hidden />Every AI answer shows the checks it passed, and you can open the exact query it ran.</li>
                    <li><Check className="h-3.5 w-3.5" aria-hidden />Cancel any time. Download or delete your data whenever you like.</li>
                </ul>

                <div className="qi-plan-actions">
                    <button type="button" className="qi-account-primary" onClick={onStart}>Start free</button>
                    <button type="button" className="qi-plan-secondary" onClick={onClose}>Back</button>
                </div>
            </div>
        </div>
    );
}
