import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { User, UserRole } from '../types';
import { indexedDBStorage } from '../services/indexedDBStorage';
import { resetUserData, useAppStore } from './useAppStore';

// ── User Data Isolation ──────────────────────────────────────────
const APP_STORAGE_KEY = 'QuickInsight-storage-v4';

/** Save current app state to a user-scoped localStorage key */
export function saveUserAppData(userId: string): void {
    try {
        const appData = localStorage.getItem(APP_STORAGE_KEY);
        if (appData) {
            localStorage.setItem(`${APP_STORAGE_KEY}-${userId}`, appData);
        }
        // Also save custom questions
        const customQ = localStorage.getItem('astrabi_custom_questions');
        if (customQ) {
            localStorage.setItem(`astrabi_custom_questions-${userId}`, customQ);
        }
    } catch (err) {
        console.warn('[Auth] Failed to save user app data:', err);
    }
}

/** Restore app state from a user-scoped localStorage key */
export function restoreUserAppData(userId: string): void {
    try {
        const userData = localStorage.getItem(`${APP_STORAGE_KEY}-${userId}`);
        if (userData) {
            localStorage.setItem(APP_STORAGE_KEY, userData);
        } else {
            // New user — clear the shared state so they start fresh
            localStorage.removeItem(APP_STORAGE_KEY);
        }
        // Restore custom questions
        const customQ = localStorage.getItem(`astrabi_custom_questions-${userId}`);
        if (customQ) {
            localStorage.setItem('astrabi_custom_questions', customQ);
        } else {
            localStorage.removeItem('astrabi_custom_questions');
        }
    } catch (err) {
        console.warn('[Auth] Failed to restore user app data:', err);
    }
}

/** Clear the shared app state (call on logout) */
export function clearSharedAppData(): void {
    try {
        localStorage.removeItem(APP_STORAGE_KEY);
        localStorage.removeItem('astrabi_custom_questions');
    } catch { /* silent */ }
}

/**
 * Secure synchronous hash using iterative mixing (SHA-256 style strength).
 * Uses multiple rounds of bit mixing for avalanche effect.
 * NOT cryptographically equivalent to SHA-256 but vastly stronger than the old simpleHash.
 */
const secureHash = (str: string): string => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
    h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
    h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return 'sh_' + combined.toString(36);
};

// Backward compatibility: keep old hash for existing users
const legacyHash = (str: string): string => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'h_' + Math.abs(hash).toString(36);
};

/** Validate password complexity */
const validatePassword = (password: string): string | null => {
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
    return null;
};

// Rate limiting state (not persisted)
let loginAttempts = 0;
let lockoutUntil = 0;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60_000; // 1 minute

// Session timeout
const SESSION_TIMEOUT_MS = 30 * 60_000; // 30 minutes
let lastActivityTime = Date.now();

/** Reset activity timer — call on user interaction */
export const touchSession = () => { lastActivityTime = Date.now(); };

/** Check if session has expired */
export const isSessionExpired = (): boolean => {
    return Date.now() - lastActivityTime > SESSION_TIMEOUT_MS;
};

// Seed admin user
const SEED_ADMIN: User = {
    id: 'admin_001',
    email: 'saicharan@QuickInsight.co.uk',
    name: 'Sai Charan',
    role: UserRole.ADMIN,
    passwordHash: secureHash('password'),
    createdAt: Date.now(),
    avatar: '#6366f1', // indigo
};

// Avatar color palette
const AVATAR_COLORS = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
    '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

const AI_SQL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

interface AuthState {
    currentUser: User | null;
    users: User[];
    isAuthenticated: boolean;

    // Actions
    login: (email: string, password: string) => { success: boolean; error?: string };
    loginAsGuest: () => void;
    register: (email: string, name: string, password: string) => { success: boolean; error?: string };
    logout: () => Promise<void>;
    addUser: (email: string, name: string, password: string, role: UserRole) => { success: boolean; error?: string };
    removeUser: (id: string) => { success: boolean; error?: string };
    updateUserRole: (id: string, role: UserRole) => void;
    updateUserPassword: (id: string, newPassword: string) => void;
    incrementAiSqlUsage: () => void;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set, get) => ({
            currentUser: null,
            users: [SEED_ADMIN],
            isAuthenticated: false,

            login: (email: string, password: string) => {
                // Rate limiting
                if (Date.now() < lockoutUntil) {
                    const remaining = Math.ceil((lockoutUntil - Date.now()) / 1000);
                    return { success: false, error: `Too many attempts. Try again in ${remaining}s` };
                }

                const state = get();
                const user = state.users.find(
                    u => u.email.toLowerCase() === email.toLowerCase()
                );
                if (!user) {
                    loginAttempts++;
                    if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
                        lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
                        loginAttempts = 0;
                    }
                    return { success: false, error: 'No account found with this email address' };
                }
                // Check both new and legacy hash for backward compatibility
                const hashMatches = user.passwordHash === secureHash(password) || user.passwordHash === legacyHash(password);
                if (!hashMatches) {
                    loginAttempts++;
                    if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
                        lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
                        loginAttempts = 0;
                    }
                    return { success: false, error: 'Incorrect password' };
                }
                // Successful login — reset attempts, update activity
                loginAttempts = 0;
                lastActivityTime = Date.now();
                // Migrate legacy hash to secure hash on successful login
                if (user.passwordHash !== secureHash(password)) {
                    set(state => ({
                        users: state.users.map(u => u.id === user.id ? { ...u, passwordHash: secureHash(password) } : u)
                    }));
                }
                // ── User Data Isolation ──
                // 1. Save previous user's app data
                saveUserAppData(get().currentUser?.id || '__anonymous__');
                // 2. Clear in-memory app state + localStorage
                resetUserData();
                // 3. Restore new user's data to localStorage
                restoreUserAppData(user.id);
                // 4. Set auth state
                set({ currentUser: user, isAuthenticated: true });
                // 5. Rehydrate app store from restored localStorage
                useAppStore.persist.rehydrate();
                return { success: true };
            },

            logout: async () => {
                const userId = get().currentUser?.id;
                if (userId) {
                    saveUserAppData(userId);
                    // ── Cloud Sync: push dashboard to PostgreSQL BEFORE clearing token ──
                    try {
                        const dashStore = require('./useDashboardStore').useDashboardStore.getState();
                        // Flush any pending debounced pushes immediately
                        if (dashStore.items && dashStore.items.length > 0) {
                            await dashStore.pushToCloud();
                            console.log('[Logout] ✅ Dashboard pushed to cloud before logout');
                        }
                    } catch (err) {
                        console.error('[Logout] ❌ Dashboard push failed:', err);
                    }
                }
                resetUserData();
                clearSharedAppData();
                // Clear JWT token and session credentials AFTER cloud push completes
                localStorage.removeItem('qi_token');
                try { sessionStorage.removeItem('qi_session_creds'); } catch {}
                set({ currentUser: null, isAuthenticated: false });
            },

            loginAsGuest: () => {
                const guestUser: User = {
                    id: 'guest_' + Date.now().toString(36),
                    email: 'guest@quickinsight.app',
                    name: 'Guest User',
                    role: UserRole.VIEWER,
                    passwordHash: '',
                    createdAt: Date.now(),
                    avatar: '#94a3b8',
                };
                lastActivityTime = Date.now();
                saveUserAppData(get().currentUser?.id || '__anonymous__');
                resetUserData();
                clearSharedAppData();
                set({ currentUser: guestUser, isAuthenticated: true });
            },

            register: (email: string, name: string, password: string) => {
                const state = get();
                if (state.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
                    return { success: false, error: 'A user with this email already exists' };
                }
                const pwError = validatePassword(password);
                if (pwError) return { success: false, error: pwError };
                if (!name.trim()) return { success: false, error: 'Name is required' };

                const newUser: User = {
                    id: Math.random().toString(36).substring(2, 15) + Date.now().toString(36),
                    email: email.toLowerCase(),
                    name,
                    role: UserRole.CONTRIBUTOR,
                    passwordHash: secureHash(password),
                    createdAt: Date.now(),
                    avatar: AVATAR_COLORS[state.users.length % AVATAR_COLORS.length],
                };
                lastActivityTime = Date.now();
                saveUserAppData(get().currentUser?.id || '__anonymous__');
                resetUserData();
                clearSharedAppData();
                set({ users: [...state.users, newUser], currentUser: newUser, isAuthenticated: true });
                return { success: true };
            },

            addUser: (email: string, name: string, password: string, role: UserRole) => {
                const state = get();
                if (state.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
                    return { success: false, error: 'A user with this email already exists' };
                }
                // Password validation
                const pwError = validatePassword(password);
                if (pwError) return { success: false, error: pwError };

                const newUser: User = {
                    id: Math.random().toString(36).substring(2, 15) + Date.now().toString(36),
                    email: email.toLowerCase(),
                    name,
                    role,
                    passwordHash: secureHash(password),
                    createdAt: Date.now(),
                    avatar: AVATAR_COLORS[state.users.length % AVATAR_COLORS.length],
                };
                set({ users: [...state.users, newUser] });
                return { success: true };
            },

            removeUser: (id: string) => {
                const state = get();
                const user = state.users.find(u => u.id === id);
                if (!user) return { success: false, error: 'User not found' };
                if (user.role === UserRole.ADMIN && state.users.filter(u => u.role === UserRole.ADMIN).length <= 1) {
                    return { success: false, error: 'Cannot remove the last admin' };
                }
                set({ users: state.users.filter(u => u.id !== id) });
                return { success: true };
            },

            updateUserRole: (id: string, role: UserRole) => {
                set(state => ({
                    users: state.users.map(u => u.id === id ? { ...u, role } : u)
                }));
            },

            updateUserPassword: (id: string, newPassword: string) => {
                set(state => ({
                    users: state.users.map(u => u.id === id ? { ...u, passwordHash: secureHash(newPassword) } : u)
                }));
            },

            incrementAiSqlUsage: () => {
                const state = get();
                if (!state.currentUser) return;
                const userId = state.currentUser.id;
                const now = Date.now();

                set(st => {
                    const updatedUsers = st.users.map(u => {
                        if (u.id !== userId) return u;
                        const usage = u.aiSqlUsage;
                        // If no usage or window expired, start fresh
                        if (!usage || (now - usage.windowStart >= AI_SQL_WINDOW_MS)) {
                            return { ...u, aiSqlUsage: { count: 1, windowStart: now } };
                        }
                        // Increment within current window
                        return { ...u, aiSqlUsage: { ...usage, count: usage.count + 1 } };
                    });
                    const updatedCurrentUser = updatedUsers.find(u => u.id === userId) || st.currentUser;
                    return { users: updatedUsers, currentUser: updatedCurrentUser };
                });
            },
        }),
        {
            name: 'QuickInsight-auth-v2',
            storage: createJSONStorage(() => indexedDBStorage), // Fix #13: IndexedDB
            partialize: (state) => ({
                currentUser: state.currentUser,
                users: state.users,
                isAuthenticated: state.isAuthenticated,
            }),
        }
    )
);

// Role permission helpers
export const ROLE_PERMISSIONS = {
    [UserRole.ADMIN]: {
        label: 'Admin',
        description: 'Full access including user management',
        color: '#f43f5e',
        canUpload: true,
        canCreateVisuals: true,
        canManageDashboard: true,
        canManageUsers: true,
        canEditSchema: true,
        canManageQuestions: true,
    },
    [UserRole.CONTRIBUTOR]: {
        label: 'Contributor',
        description: 'Upload data, create visuals, manage dashboards',
        color: '#8b5cf6',
        canUpload: true,
        canCreateVisuals: true,
        canManageDashboard: true,
        canManageUsers: false,
        canEditSchema: true,
        canManageQuestions: false,
    },
    [UserRole.VIEWER]: {
        label: 'Viewer',
        description: 'View dashboards and existing visuals only',
        color: '#06b6d4',
        canUpload: false,
        canCreateVisuals: false,
        canManageDashboard: false,
        canManageUsers: false,
        canEditSchema: false,
        canManageQuestions: false,
    },
};
