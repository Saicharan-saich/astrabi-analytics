import { describe, expect, it } from 'vitest';
import { cleanedByOlderVersion } from '../utils/etlChangeSummary';
import { runETLPipeline } from '../services/etlPipeline';
import type { ETLLog } from '../types';

const oldLog = (extra: Partial<ETLLog>): ETLLog => ({ step: 'Duplicate Row Removal', stepNumber: 1, status: 'applied', timestamp: 1, details: 'Removed 19 duplicate row(s). Strategy: primary key match on 1 unique ID column(s): order_id.', ...extra } as ETLLog);

describe('cleaning made by an earlier version', () => {
    it('spots an old duplicate removal with no undo, and blank IDs removed as "duplicates"', () => {
        const result = cleanedByOlderVersion([oldLog({ rowsBefore: 3212, rowsAfter: 3193, removedRowSamples: [{ order_id: null, region: 'London' }] })]);
        expect(result).toEqual({ stale: true, blankKeyDuplicates: 19 });
    });

    it('does not flag cleaning done by the current version', () => {
        const raw = [
            ...Array.from({ length: 30 }, (_, i) => ({ order_id: `O-${i}`, region: i % 2 ? 'North' : 'South', sales: 100 + i })),
            { order_id: 'O-1', region: 'North', sales: 101 },
            { order_id: '', region: 'North', sales: 5 }, { order_id: '', region: 'North', sales: 5 },
        ];
        const { logs, rows } = runETLPipeline(raw, 'orders.csv');
        expect(cleanedByOlderVersion(logs).stale).toBe(false);
        // Rows with a blank ID are never removed as duplicates of each other.
        expect(rows.filter(row => !row.order_id).length).toBe(2);
    });
});
