import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveDatasetsAtomically } from '../services/datasetDB';

afterEach(() => vi.unstubAllGlobals());

function database(failPut = false) {
    const put = vi.fn(() => { if (failPut) throw new Error('quota exceeded'); });
    const tx: any = { objectStore: () => ({ put }), abort: vi.fn() };
    const db = { transaction: vi.fn(() => tx), close: vi.fn() };
    vi.stubGlobal('indexedDB', { open: () => {
        const request: any = { result: db };
        queueMicrotask(() => { request.onsuccess(); queueMicrotask(() => tx.oncomplete?.()); });
        return request;
    } });
    return { tx, db, put };
}

describe('relationship model persistence', () => {
    it('writes the root and subject in one transaction', async () => {
        const { db, put } = database();
        await saveDatasetsAtomically([{ id: 'root' }, { id: 'subject' }]);
        expect(db.transaction).toHaveBeenCalledTimes(1);
        expect(put.mock.calls).toHaveLength(2);
        expect(db.close).toHaveBeenCalled();
    });
    it('aborts and exposes storage errors to the editor', async () => {
        const { tx, db } = database(true);
        await expect(saveDatasetsAtomically([{ id: 'root' }, { id: 'subject' }])).rejects.toThrow('quota exceeded');
        expect(tx.abort).toHaveBeenCalled();
        expect(db.close).toHaveBeenCalled();
    });
});
