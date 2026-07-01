/**
 * useDataStore.ts — Dataset state (NOT persisted to localStorage)
 * 
 * Datasets are persisted via IndexedDB (datasetDB.ts), NOT localStorage.
 * This prevents localStorage quota crashes on large datasets.
 * 
 * Extracted from the monolithic useAppStore for architectural separation.
 */
import { create } from 'zustand';
import { Dataset } from '../types';

interface DataState {
    dataset: Dataset | null;
    datasets: Dataset[];
    isProcessing: boolean;
    error: string | null;

    setDataset: (dataset: Dataset | null) => void;
    addDataset: (dataset: Dataset) => void;
    removeDataset: (id: string) => void;
    setActiveDatasetById: (id: string) => void;
    setProcessing: (isProcessing: boolean) => void;
    setError: (error: string | null) => void;
}

export const useDataStore = create<DataState>()(
    (set) => ({
        dataset: null,
        datasets: [],
        isProcessing: false,
        error: null,

        setDataset: (dataset) => set((state) => {
            if (!dataset) return { dataset };
            const exists = state.datasets.some(d => d.id === dataset.id);
            return {
                dataset,
                datasets: exists
                    ? state.datasets.map(d => d.id === dataset.id ? dataset : d)
                    : [...state.datasets, dataset]
            };
        }),
        addDataset: (dataset) => set((state) => {
            const exists = state.datasets.some(d => d.id === dataset.id);
            return { datasets: exists ? state.datasets : [...state.datasets, dataset] };
        }),
        removeDataset: (id) => set((state) => ({
            datasets: state.datasets.filter(d => d.id !== id),
            dataset: state.dataset?.id === id
                ? (state.datasets.filter(d => d.id !== id)[0] || null)
                : state.dataset
        })),
        setActiveDatasetById: (id) => set((state) => ({
            dataset: state.datasets.find(d => d.id === id) || state.dataset
        })),
        setProcessing: (isProcessing) => set({ isProcessing }),
        setError: (error) => set({ error }),
    })
);
