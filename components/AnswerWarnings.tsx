import React, { useEffect, useState } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import type { AnswerWarning } from '../utils/answerWarnings';

/** Warnings before an answer misleads, each with the fix one click away. */
export const AnswerWarnings: React.FC<{ warnings: AnswerWarning[]; onFix: (config: Record<string, any>) => void }> = ({ warnings, onFix }) => {
    const [hidden, setHidden] = useState<Set<string>>(new Set());
    const signature = warnings.map(w => w.text).join('|');
    useEffect(() => { setHidden(new Set()); }, [signature]);
    const shown = warnings.filter(w => !hidden.has(w.id));
    if (!shown.length) return null;
    return (
        <ul className="qi-warn" aria-label="Before you rely on this">
            {shown.map(w => (
                <li key={w.id} className="qi-warn-item">
                    <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="qi-warn-text">{w.text}</span>
                    <button type="button" className="qi-warn-fix" onClick={() => onFix(w.fix)}>{w.fixLabel}</button>
                    <button type="button" className="qi-warn-close" aria-label="Dismiss this warning" onClick={() => setHidden(prev => new Set([...prev, w.id]))}><X className="h-3 w-3" aria-hidden /></button>
                </li>
            ))}
        </ul>
    );
};
