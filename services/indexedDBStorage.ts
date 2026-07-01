/**
 * IndexedDB Storage Adapter for Zustand Persist
 * Fix #13: Replaces localStorage with IndexedDB for larger storage capacity.
 * localStorage has a 5MB cap — IndexedDB supports 50MB+.
 * 
 * Usage: createJSONStorage(() => indexedDBStorage)
 */

const DB_NAME = 'QuickInsight-store';
const DB_VERSION = 1;
const STORE_NAME = 'zustand';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

/**
 * A Storage-compatible adapter backed by IndexedDB.
 * Works with zustand's createJSONStorage().
 */
export const indexedDBStorage: Storage = {
    get length() {
        // Not strictly needed for zustand, return 0
        return 0;
    },

    key(_index: number): string | null {
        // Not needed for zustand
        return null;
    },

    clear(): void {
        openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).clear();
        }).catch(() => { /* silent */ });
    },

    getItem(name: string): string | null {
        // zustand's createJSONStorage expects sync or thenable return
        // We return a Promise which zustand handles correctly
        const result = openDB().then(db => {
            return new Promise<string | null>((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const request = tx.objectStore(STORE_NAME).get(name);
                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => reject(request.error);
            });
        }).catch(() => {
            // Fallback to localStorage if IndexedDB fails
            try { return localStorage.getItem(name); } catch { return null; }
        });
        return result as any;
    },

    setItem(name: string, value: string): void {
        openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).put(value, name);
        }).catch(() => {
            // Fallback to localStorage if IndexedDB fails
            try { localStorage.setItem(name, value); } catch { /* storage full */ }
        });
    },

    removeItem(name: string): void {
        openDB().then(db => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            tx.objectStore(STORE_NAME).delete(name);
        }).catch(() => {
            try { localStorage.removeItem(name); } catch { /* silent */ }
        });
    }
};
