/**
 * What every screen shows before any data is loaded: what this screen will
 * do once there is data, and the way to get started — never a dead end.
 */
import { BarChart3, FileUp, MessageCircleQuestion, Sparkles, Wand2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { Tab } from '../types';

interface Props {
    /** The screen's name, e.g. "AI SQL". */
    title: string;
    /** What it does once data is loaded, in one plain sentence. */
    purpose: string;
}

export function NoDataYet({ title, purpose }: Props) {
    const setActiveTab = useAppStore(state => state.setActiveTab);
    const requestSampleData = useAppStore(state => state.requestSampleData);
    return (
        <div className="qi-nodata" role="region" aria-label={`${title}: no data yet`}>
            <div className="qi-nodata-card">
                <div className="qi-nodata-mark" aria-hidden><Sparkles className="h-6 w-6" /></div>
                <h2>{title} needs some data first</h2>
                <p>{purpose}</p>
                <ol className="qi-nodata-steps" aria-label="How to get started">
                    <li><FileUp className="h-4 w-4" aria-hidden /><span><strong>Bring in your data</strong>Upload a spreadsheet or connect your shop or database.</span></li>
                    <li><Wand2 className="h-4 w-4" aria-hidden /><span><strong>We clean it for you</strong>Dates, numbers and duplicates are tidied, and you see every change.</span></li>
                    <li><MessageCircleQuestion className="h-4 w-4" aria-hidden /><span><strong>Ask and explore</strong>Ask questions in plain English and pin the answers to a dashboard.</span></li>
                </ol>
                <div className="qi-nodata-actions">
                    <button type="button" className="qi-nodata-primary" onClick={() => setActiveTab(Tab.UPLOAD)}>
                        <FileUp className="h-4 w-4" aria-hidden /> Bring in your data
                    </button>
                    <button type="button" className="qi-nodata-secondary" onClick={() => requestSampleData()}>
                        <BarChart3 className="h-4 w-4" aria-hidden /> Try it with sample data
                    </button>
                </div>
            </div>
        </div>
    );
}
