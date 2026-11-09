/**
 * The answer check, shown under every answer: one line saying whether every
 * figure matched a fresh, independent calculation from the cleaned data, and
 * details on demand (what was counted, how many rows, any differences).
 */
import { useState } from 'react';
import { ChevronDown, Loader2, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { AnswerCheck } from '../services/answerCheck/answerCheck';

interface Props {
    check?: AnswerCheck | 'pending';
    /** Offered when there is no check yet (an answer reopened from history). */
    onRun?: () => void;
    running?: boolean;
}

const ICON = { verified: ShieldCheck, warning: ShieldAlert, mismatch: ShieldAlert, partial: Shield } as const;
const LABEL = { verified: 'Checked', warning: 'Checked', mismatch: 'Check failed', partial: 'Partly checked' } as const;

export function AnswerCheckStrip({ check, onRun, running }: Props) {
    const [open, setOpen] = useState(false);
    if (check === 'pending' || running) {
        return (
            <div className="qi-check is-pending" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                <span>Checking every figure against your cleaned data…</span>
            </div>
        );
    }
    if (!check) {
        return onRun ? (
            <div className="qi-check is-idle">
                <Shield className="h-4 w-4" aria-hidden />
                <button type="button" className="qi-check-run" onClick={onRun}>Check these figures against your cleaned data</button>
            </div>
        ) : null;
    }
    const Icon = ICON[check.status];
    const missing = check.filterValues.filter(f => f.matches === 0);
    const hasDetail = Boolean(check.counted || check.coverage || check.notes.length || check.differences.length || missing.length || check.reason);
    return (
        <div className={`qi-check is-${check.status}`} role={check.status === 'mismatch' ? 'alert' : 'status'}>
            <div className="qi-check-line">
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <p><strong>{check.status === 'warning' && !check.figuresChecked ? 'Check' : LABEL[check.status]}:</strong> {check.headline}</p>
                {hasDetail && (
                    <button type="button" className="qi-check-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
                        {open ? 'Hide' : 'How it was checked'} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
                    </button>
                )}
            </div>
            {check.thingsToKnow?.length > 0 && (
                <ul className="qi-check-things" aria-label="Things to know">
                    {check.thingsToKnow.map(item => <li key={item}>{item}</li>)}
                </ul>
            )}
            {open && (
                <div className="qi-check-body">
                    {check.counted && <p><span className="qi-check-k">What was counted</span>{check.counted}</p>}
                    {check.coverage && <p><span className="qi-check-k">Rows used</span>{check.coverage}</p>}
                    {check.figuresChecked > 0 && (
                        <p><span className="qi-check-k">Figures</span>{check.figuresMatched.toLocaleString('en-GB')} of {check.figuresChecked.toLocaleString('en-GB')} match a second calculation</p>
                    )}
                    {missing.map(f => (
                        <p key={`${f.column}-${f.value}`}>
                            <span className="qi-check-k">Filter</span>
                            No rows have {f.column} = “{f.value}”.{f.suggestions.length ? ` Values in your data that look close: ${f.suggestions.map(s => `“${s}”`).join(', ')}.` : ''}
                        </p>
                    ))}
                    {check.notes.map(note => <p key={note}><span className="qi-check-k">Note</span>{note}</p>)}
                    {check.differences.length > 0 && (
                        <div className="qi-check-table" role="region" aria-label="Figures that differ" tabIndex={0}>
                            <table>
                                <thead><tr><th>Where</th><th>Figure</th><th>In the answer</th><th>Fresh calculation</th></tr></thead>
                                <tbody>
                                    {check.differences.slice(0, 20).map((d, i) => (
                                        <tr key={`${d.where}-${d.column}-${i}`}><td>{d.where}</td><td>{d.column || '—'}</td><td>{d.shown}</td><td>{d.recomputed}</td></tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                    {check.reason && check.status !== 'verified' && <p><span className="qi-check-k">Not recomputed</span>The query uses {check.reason}, which the checker can’t work out yet; the other checks above still ran.</p>}
                    <p className="qi-check-foot">Worked out a second time in your browser, from your cleaned data, by a separate calculator — not the one that answered. Nothing was sent anywhere. ({check.ms} ms)</p>
                </div>
            )}
        </div>
    );
}
