import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ─── Activity Tracking Store ────────────────────────────────────
// Tracks user activities across the application for admin insights.
// All data is stored in localStorage — fully browser-native, no server required.

export interface UserActivity {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: string;
  action: ActivityAction;
  details?: string;
  timestamp: number;
}

export type ActivityAction =
  | 'login'
  | 'logout'
  | 'upload_dataset'
  | 'ai_sql_query'
  | 'builder_query'
  | 'smart_question'
  | 'pin_to_dashboard'
  | 'create_alert'
  | 'tab_visit'
  | 'export_data'
  | 'register';

export interface UserInsightSummary {
  userId: string;
  userName: string;
  userEmail: string;
  userRole: string;
  totalActions: number;
  lastActive: number;
  firstSeen: number;
  loginCount: number;
  aiSqlQueries: number;
  builderQueries: number;
  datasetsUploaded: number;
  dashboardPins: number;
  alertsCreated: number;
  smartQuestions: number;
  tabVisits: Record<string, number>;
  // Engagement
  activeDays: number;
  avgActionsPerDay: number;
}

interface ActivityState {
  activities: UserActivity[];
  // Actions
  trackActivity: (activity: Omit<UserActivity, 'timestamp'>) => void;
  getActivities: (userId?: string) => UserActivity[];
  getUserSummaries: () => UserInsightSummary[];
  getRecentActivities: (limit?: number) => UserActivity[];
  clearActivities: () => void;
}

const MAX_ACTIVITIES = 10000; // Cap at 10k to prevent localStorage bloat

// ── Backend Sync (fire-and-forget) ──────────────────────────────
const API_BASE_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL) || 'https://api.quickinsight.co.uk';

function syncToBackend(activity: UserActivity): void {
    try {
        const token = localStorage.getItem('qi_token') || '';
        if (!token) return;
        const apiKey = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_KEY) || '';
        fetch(`${API_BASE_URL}/api/activities`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...(apiKey ? { 'x-api-key': apiKey } : {}),
            },
            body: JSON.stringify({
                userId: activity.userId,
                userName: activity.userName,
                userEmail: activity.userEmail,
                userRole: activity.userRole,
                action: activity.action,
                details: activity.details || null,
            }),
        }).catch(() => { /* silent — don't break UX if backend is down */ });
    } catch { /* silent */ }
}

export const useActivityStore = create<ActivityState>()(
  persist(
    (set, get) => ({
      activities: [],

      trackActivity: (activity) => {
        const newActivity: UserActivity = {
            ...activity,
            timestamp: Date.now(),
        };

        // Sync to backend PostgreSQL (fire-and-forget)
        syncToBackend(newActivity);

        // Also keep in localStorage for offline/fallback
        set(state => {
          const updated = [...state.activities, newActivity];
          if (updated.length > MAX_ACTIVITIES) {
            return { activities: updated.slice(-MAX_ACTIVITIES) };
          }
          return { activities: updated };
        });
      },

      getActivities: (userId) => {
        const { activities } = get();
        if (!userId) return activities;
        return activities.filter(a => a.userId === userId);
      },

      getRecentActivities: (limit = 50) => {
        const { activities } = get();
        return activities.slice(-limit).reverse();
      },

      getUserSummaries: () => {
        const { activities } = get();
        const userMap = new Map<string, UserActivity[]>();

        for (const a of activities) {
          if (!userMap.has(a.userId)) userMap.set(a.userId, []);
          userMap.get(a.userId)!.push(a);
        }

        const summaries: UserInsightSummary[] = [];

        for (const [userId, acts] of userMap) {
          const last = acts[acts.length - 1];
          const tabVisits: Record<string, number> = {};
          let loginCount = 0;
          let aiSqlQueries = 0;
          let builderQueries = 0;
          let datasetsUploaded = 0;
          let dashboardPins = 0;
          let alertsCreated = 0;
          let smartQuestions = 0;
          const activeDaysSet = new Set<string>();

          for (const a of acts) {
            const dayKey = new Date(a.timestamp).toISOString().split('T')[0];
            activeDaysSet.add(dayKey);

            switch (a.action) {
              case 'login': loginCount++; break;
              case 'ai_sql_query': aiSqlQueries++; break;
              case 'builder_query': builderQueries++; break;
              case 'upload_dataset': datasetsUploaded++; break;
              case 'pin_to_dashboard': dashboardPins++; break;
              case 'create_alert': alertsCreated++; break;
              case 'smart_question': smartQuestions++; break;
              case 'tab_visit':
                if (a.details) {
                  tabVisits[a.details] = (tabVisits[a.details] || 0) + 1;
                }
                break;
            }
          }

          const activeDays = activeDaysSet.size;
          const avgActionsPerDay = activeDays > 0 ? Math.round(acts.length / activeDays * 10) / 10 : 0;

          summaries.push({
            userId,
            userName: last.userName,
            userEmail: last.userEmail,
            userRole: last.userRole,
            totalActions: acts.length,
            lastActive: last.timestamp,
            firstSeen: acts[0].timestamp,
            loginCount,
            aiSqlQueries,
            builderQueries,
            datasetsUploaded,
            dashboardPins,
            alertsCreated,
            smartQuestions,
            tabVisits,
            activeDays,
            avgActionsPerDay,
          });
        }

        // Sort by most active first
        summaries.sort((a, b) => b.totalActions - a.totalActions);
        return summaries;
      },

      clearActivities: () => set({ activities: [] }),
    }),
    {
      name: 'qi-activity-store',
    }
  )
);
