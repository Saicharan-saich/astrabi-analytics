/**
 * useUiStore.ts — UI-only state (persisted)
 * Handles sidebar, themes, font settings, and layout preferences.
 * Extracted from the monolithic useAppStore for architectural separation.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Tab } from '../types';

interface UIState {
    activeTab: Tab;
    isSidebarOpen: boolean;
    showAbout: boolean;
    appFontSize: number;
    appFontBold: boolean;
    theme: 'dark' | 'light';

    setActiveTab: (tab: Tab) => void;
    toggleSidebar: () => void;
    toggleAbout: (show: boolean) => void;
    setAppFontSize: (size: number) => void;
    toggleAppFontBold: () => void;
    setTheme: (theme: 'dark' | 'light') => void;
    toggleTheme: () => void;
}

export const useUiStore = create<UIState>()(
    persist(
        (set) => ({
            activeTab: Tab.UPLOAD,
            isSidebarOpen: true,
            showAbout: false,
            appFontSize: 14,
            appFontBold: false,
            theme: 'dark',

            setActiveTab: (tab) => set({ activeTab: tab }),
            toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
            toggleAbout: (show) => set({ showAbout: show }),
            setAppFontSize: (size) => set({ appFontSize: size }),
            toggleAppFontBold: () => set((state) => ({ appFontBold: !state.appFontBold })),
            setTheme: (theme) => set({ theme }),
            toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
        }),
        {
            name: 'QuickInsight-ui-v1',
            storage: createJSONStorage(() => localStorage),
        }
    )
);
