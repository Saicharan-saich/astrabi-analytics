/**
 * The briefing at the top of the workspace: the latest full week (or month)
 * against a usual one — what changed, what explains it, what to look at, and
 * a question to ask next. Worked out in the browser from the cleaned data.
 */
import { useMemo, useState } from 'react';
import { ArrowRight, ChevronDown, Sunrise } from 'lucide-react';
import type { Dataset } from '../types';
import { buildBriefing, type BriefingTone } from '../services/weeklyBriefing';

interface Props {
    dataset: Dataset;
    /** Open AI SQL with this question ready to send. */
    onAsk?: (question: string) => void;
}

const toneClass = (tone: BriefingTone) => (tone === 'good' ? 'is-good' : tone === 'bad' ? 'is-bad' : 'is-neutral');

export function WeeklyBriefingCard({ dataset, onAsk }: Props) {
    const briefing = useMemo(() => {
        try { return buildBriefing(dataset); } catch (err) { console.warn('[briefing] could not build', err); return null; }
    }, [dataset]);
    const [showAll, setShowAll] = useState(false);
    if (!briefing) return null;
    if (briefing.status !== 'ready') {
        return (
            <section className="qi-ws-card qi-brief is-empty rounded-xl" aria-label="Your briefing">
                <Sunrise className="h-4 w-4 shrink-0" aria-hidden />
                <p><strong>Your briefing</strong> — {briefing.reason}</p>
            </section>
        );
    }
    const findings = showAll ? briefing.findings : briefing.findings.slice(0, 3);
    return (
        <section className="qi-ws-card qi-brief rounded-xl" aria-labelledby="qi-brief-title">
            <header className="qi-brief-head">
                <span className="qi-brief-icon" aria-hidden><Sunrise className="h-4 w-4" /></span>
                <div className="min-w-0">
                    <h2 id="qi-brief-title">Your briefing</h2>
                    <p className="qi-brief-period">{briefing.periodLabel}</p>
                </div>
            </header>
            <p className="qi-brief-headline">{briefing.headline}</p>
            {briefing.stale && <p className="qi-brief-stale" role="note">{briefing.stale}</p>}

            <dl className="qi-brief-figures">
                {briefing.figures.map(f => (
                    <div key={f.label} className="qi-brief-figure">
                        <dt>{f.label}</dt>
                        <dd className="qi-brief-value">{f.value}</dd>
                        {f.change && <dd className={`qi-brief-change ${toneClass(f.tone)}`}>{f.change}</dd>}
                    </div>
                ))}
            </dl>

            {briefing.findings.length > 0 ? (
                <ul className="qi-brief-findings">
                    {findings.map(f => (
                        <li key={f.text} className={toneClass(f.tone)}>
                            <p className="qi-brief-text">{f.text}</p>
                            {f.check && <p className="qi-brief-check"><span>What to look at</span>{f.check}</p>}
                            {f.ask && onAsk && (
                                <button type="button" className="qi-brief-ask" onClick={() => onAsk(f.ask!)}>
                                    Ask about this <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="qi-brief-quiet">Nothing stood out: every part of the business was within its usual range.</p>
            )}
            {briefing.findings.length > 3 && (
                <button type="button" className="qi-brief-more" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
                    {showAll ? 'Show less' : `${briefing.findings.length - 3} more`} <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showAll ? 'rotate-180' : ''}`} aria-hidden />
                </button>
            )}
            <p className="qi-brief-foot">
                Compared with the average of the {briefing.grain}s before. Worked out in your browser from your cleaned data{briefing.dataUntil ? ` (up to ${new Date(`${briefing.dataUntil}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })})` : ''}; nothing was sent anywhere.
            </p>
        </section>
    );
}
