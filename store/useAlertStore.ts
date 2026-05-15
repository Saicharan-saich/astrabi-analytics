/**
 * useAlertStore.ts — Monitoring Alert state (persisted via IndexedDB)
 * Manages alert rules, triggered events, and unread notification count.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { AlertRule, AlertEvent, AlertSeverity } from '../types';
import { indexedDBStorage } from '../services/indexedDBStorage';

const MAX_EVENTS = 100;
const MAX_RULES = 25;

interface AlertState {
    // Alert rules
    rules: AlertRule[];
    addRule: (rule: AlertRule) => void;
    updateRule: (rule: AlertRule) => void;
    deleteRule: (id: string) => void;
    duplicateRule: (id: string) => void;
    snoozeRule: (id: string, hours: number) => void;
    enableRule: (id: string) => void;
    disableRule: (id: string) => void;

    // Alert events (triggered history)
    events: AlertEvent[];
    addEvent: (event: AlertEvent) => void;
    acknowledgeEvent: (id: string) => void;
    acknowledgeAll: () => void;
    clearOldEvents: (olderThanMs: number) => void;

    // Unread count
    unreadCount: number;
    recalcUnread: () => void;
}

export const useAlertStore = create<AlertState>()(
    persist(
        (set, get) => ({
            // ── Rules ────────────────────────────────────────────
            rules: [],
            addRule: (rule) => set((state) => ({
                rules: [...state.rules, rule].slice(0, MAX_RULES)
            })),
            updateRule: (updatedRule) => set((state) => ({
                rules: state.rules.map((r) => r.id === updatedRule.id ? updatedRule : r)
            })),
            deleteRule: (id) => set((state) => ({
                rules: state.rules.filter((r) => r.id !== id),
                events: state.events.filter((e) => e.ruleId !== id),
            })),
            duplicateRule: (id) => set((state) => {
                const src = state.rules.find(r => r.id === id);
                if (!src) return state;
                const clone: AlertRule = {
                    ...src,
                    id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                    name: `${src.name} (Copy)`,
                    status: 'disabled',
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    lastEvaluatedAt: undefined,
                    lastTriggeredAt: undefined,
                    lastValue: undefined,
                };
                return { rules: [...state.rules, clone].slice(0, MAX_RULES) };
            }),
            snoozeRule: (id, hours) => set((state) => ({
                rules: state.rules.map((r) =>
                    r.id === id
                        ? { ...r, status: 'snoozed' as const, snoozedUntil: Date.now() + hours * 3600000, updatedAt: Date.now() }
                        : r
                )
            })),
            enableRule: (id) => set((state) => ({
                rules: state.rules.map((r) =>
                    r.id === id
                        ? { ...r, status: 'active' as const, snoozedUntil: undefined, updatedAt: Date.now() }
                        : r
                )
            })),
            disableRule: (id) => set((state) => ({
                rules: state.rules.map((r) =>
                    r.id === id
                        ? { ...r, status: 'disabled' as const, updatedAt: Date.now() }
                        : r
                )
            })),

            // ── Events ───────────────────────────────────────────
            events: [],
            addEvent: (event) => set((state) => {
                const newEvents = [event, ...state.events].slice(0, MAX_EVENTS);
                return {
                    events: newEvents,
                    unreadCount: newEvents.filter(e => !e.acknowledged).length,
                };
            }),
            acknowledgeEvent: (id) => set((state) => {
                const newEvents = state.events.map(e =>
                    e.id === id ? { ...e, acknowledged: true, acknowledgedAt: Date.now() } : e
                );
                return {
                    events: newEvents,
                    unreadCount: newEvents.filter(e => !e.acknowledged).length,
                };
            }),
            acknowledgeAll: () => set((state) => ({
                events: state.events.map(e => ({ ...e, acknowledged: true, acknowledgedAt: Date.now() })),
                unreadCount: 0,
            })),
            clearOldEvents: (olderThanMs) => set((state) => {
                const cutoff = Date.now() - olderThanMs;
                const newEvents = state.events.filter(e => e.triggeredAt > cutoff);
                return {
                    events: newEvents,
                    unreadCount: newEvents.filter(e => !e.acknowledged).length,
                };
            }),

            // ── Unread ───────────────────────────────────────────
            unreadCount: 0,
            recalcUnread: () => set((state) => ({
                unreadCount: state.events.filter(e => !e.acknowledged).length,
            })),
        }),
        {
            name: 'QuickInsight-alerts-v1',
            storage: createJSONStorage(() => indexedDBStorage),
        }
    )
);
