/**
 * Analysis Web Worker — runs runAnalysis off the main UI thread.
 *
 * Messages IN:
 *   { type: 'RUN_ANALYSIS', dataset, query }
 *
 * Messages OUT:
 *   { type: 'SUCCESS', result }
 *   { type: 'ERROR', error }
 */

import { runAnalysis } from '../services/analysisEngine';

self.onmessage = (e: MessageEvent) => {
    const { type, dataset, query } = e.data;

    try {
        if (type === 'RUN_ANALYSIS') {
            const result = runAnalysis(dataset, query);
            self.postMessage({ type: 'SUCCESS', result });
        }
    } catch (error: any) {
        self.postMessage({ type: 'ERROR', error: error.message || 'Unknown Analysis Worker Error' });
    }
};
