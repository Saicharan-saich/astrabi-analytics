/**
 * IndexedDB-backed dataset persistence.
 * Unlike localStorage (5MB cap), IndexedDB supports 50MB+ and handles large datasets.
 */

import { useAuthStore } from '../store/useAuthStore';
const DB_NAME = 'QuickInsight-datasets';
const DB_VERSION = 1;
const STORE_NAME = 'datasets';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

export async function saveDatasetToDB(dataset: any): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        // Stamp ownerId for user data isolation (if not already set)
        if (!dataset.ownerId) {
            const userId = useAuthStore.getState().currentUser?.id;
            if (userId) {
                dataset = { ...dataset, ownerId: userId };
            }
        }
        store.put(dataset);
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('[IndexedDB] Failed to save dataset:', err);
    }
}

export async function loadAllDatasetsFromDB(userId?: string): Promise<any[]> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                let results = request.result || [];
                // User data isolation: filter by ownerId if userId is provided
                if (userId) {
                    results = results.filter((ds: any) => !ds.ownerId || ds.ownerId === userId);
                }
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('[IndexedDB] Failed to load datasets:', err);
        return [];
    }
}

export async function deleteDatasetFromDB(id: string): Promise<void> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(id);
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (err) {
        console.warn('[IndexedDB] Failed to delete dataset:', err);
    }
}

export async function loadDatasetByIdFromDB(id: string): Promise<any | null> {
    try {
        const db = await openDB();
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(id);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch (err) {
        console.warn('[IndexedDB] Failed to load dataset:', err);
        return null;
    }
}
