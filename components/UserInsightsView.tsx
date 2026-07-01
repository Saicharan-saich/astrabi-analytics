import React, { useState, useMemo } from 'react';
import {
  Users, Activity, TrendingUp, Clock, BarChart3, Sparkles, Search, Upload,
  Layout, Bell, Brain, Crown, Pencil, Eye, ChevronDown, ChevronRight,
  MessageSquare, Zap, Calendar, ArrowUpRight, ArrowDownRight, Minus,
  RefreshCw, Globe, Loader2
} from 'lucide-react';
import { useActivityStore, UserInsightSummary, UserActivity } from '../store/useActivityStore';
import { useTheme } from './ThemeProvider';
import { UserRole } from '../types';

const ACTION_LABELS: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  login: { label: 'Logged in', icon: <Users className="w-3.5 h-3.5" />, color: 'text-emerald-500' },
  logout: { label: 'Logged out', icon: <Users className="w-3.5 h-3.5" />, color: 'text-gray-400' },
  upload_dataset: { label: 'Uploaded dataset', icon: <Upload className="w-3.5 h-3.5" />, color: 'text-blue-500' },
  ai_sql_query: { label: 'AI SQL query', icon: <Sparkles className="w-3.5 h-3.5" />, color: 'text-violet-500' },
  builder_query: { label: 'Builder query', icon: <Search className="w-3.5 h-3.5" />, color: 'text-cyan-500' },
  smart_question: { label: 'Smart question', icon: <Brain className="w-3.5 h-3.5" />, color: 'text-amber-500' },
  pin_to_dashboard: { label: 'Pinned to dashboard', icon: <Layout className="w-3.5 h-3.5" />, color: 'text-indigo-500' },
  create_alert: { label: 'Created alert', icon: <Bell className="w-3.5 h-3.5" />, color: 'text-red-500' },
  tab_visit: { label: 'Visited tab', icon: <Activity className="w-3.5 h-3.5" />, color: 'text-gray-400' },
  export_data: { label: 'Exported data', icon: <ArrowUpRight className="w-3.5 h-3.5" />, color: 'text-teal-500' },
  register: { label: 'Registered', icon: <Users className="w-3.5 h-3.5" />, color: 'text-green-500' },
};

const getRoleIcon = (role: string) => {
  switch (role) {
    case UserRole.ADMIN: return <Crown className="w-3 h-3" />;
    case UserRole.CONTRIBUTOR: return <Pencil className="w-3 h-3" />;
    case UserRole.VIEWER: return <Eye className="w-3 h-3" />;
    default: return <Users className="w-3 h-3" />;
  }
};

const getRoleBadge = (role: string, isDark: boolean) => {
  switch (role) {
    case UserRole.ADMIN: return isDark ? 'bg-rose-500/15 text-rose-400 border-rose-500/20' : 'bg-rose-50 text-rose-600 border-rose-200';
    case UserRole.CONTRIBUTOR: return isDark ? 'bg-violet-500/15 text-violet-400 border-violet-500/20' : 'bg-violet-50 text-violet-600 border-violet-200';
    case UserRole.VIEWER: return isDark ? 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20' : 'bg-sky-50 text-sky-600 border-sky-200';
    default: return isDark ? 'bg-gray-500/15 text-gray-400 border-gray-500/20' : 'bg-gray-50 text-gray-600 border-gray-200';
  }
};

const timeAgo = (ts: number): string => {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
};

export const UserInsightsView: React.FC = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  // localStorage fallback
  const localStore = useActivityStore();

  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'overview' | 'activity'>('overview');
  const [isLoading, setIsLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);

  // ── Backend data state ──
  const [backendSummaries, setBackendSummaries] = useState<UserInsightSummary[]>([]);
  const [backendActivities, setBackendActivities] = useState<UserActivity[]>([]);
  const [usingBackend, setUsingBackend] = useState(false);

  const API_BASE_URL = (import.meta as any).env?.VITE_API_BASE_URL || 'https://api.quickinsight.co.uk';

  // Get JWT token from localStorage
  const getToken = (): string | null => {
    try {
      return localStorage.getItem('qi_token') || null;
    } catch {}
    return null;
  };

  const fetchFromBackend = async () => {
    setIsLoading(true);
    setBackendError(null);
    const token = getToken();

    try {
      // Fetch summaries
      const summaryRes = await fetch(`${API_BASE_URL}/api/activities/summary`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (summaryRes.ok) {
        const summaryData = await summaryRes.json();
        if (summaryData.success && summaryData.summaries) {
          setBackendSummaries(summaryData.summaries);
          setUsingBackend(true);
        }
      }

      // Fetch recent activities
      const actRes = await fetch(`${API_BASE_URL}/api/activities?limit=500`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });

      if (actRes.ok) {
        const actData = await actRes.json();
        if (actData.success && actData.activities) {
          setBackendActivities(actData.activities);
        }
      }
    } catch (err: any) {
      console.warn('[UserInsights] Backend fetch failed, using localStorage fallback:', err.message);
      setBackendError('Using local data — backend unavailable');
      setUsingBackend(false);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch on mount
  React.useEffect(() => { fetchFromBackend(); }, []);

  // Use backend data if available, else fall back to localStorage
  const summaries = usingBackend ? backendSummaries : localStore.getUserSummaries();
  const recentActivities = usingBackend
    ? backendActivities.slice(0, 100)
    : localStore.getRecentActivities(100);

  const selectedSummary = summaries.find(s => s.userId === selectedUser);
  const selectedActivities = useMemo(
    () => selectedUser
      ? (usingBackend
          ? backendActivities.filter(a => a.userId === selectedUser).slice(0, 200)
          : localStore.getActivities(selectedUser).reverse().slice(0, 200))
      : [],
    [selectedUser, usingBackend, backendActivities, localStore]
  );

  // Aggregate stats
  const totalUsers = summaries.length;
  const activeToday = summaries.filter(s => {
    const today = new Date().toISOString().split('T')[0];
    return new Date(s.lastActive).toISOString().split('T')[0] === today;
  }).length;
  const totalQueries = summaries.reduce((sum, s) => sum + s.aiSqlQueries + s.builderQueries + s.smartQuestions, 0);
  const totalUploads = summaries.reduce((sum, s) => sum + s.datasetsUploaded, 0);

  const cardCls = `rounded-2xl border p-5 transition-all ${isDark ? 'bg-[#1a1f2e] border-white/[0.06]' : 'bg-white border-gray-200 shadow-sm'}`;
  const headerText = isDark ? 'text-white' : 'text-gray-900';
  const subtleText = isDark ? 'text-gray-400' : 'text-gray-500';
  const mutedText = isDark ? 'text-gray-500' : 'text-gray-400';

  return (
    <div className="h-full w-full overflow-auto">
      <div className={`max-w-7xl mx-auto p-6 space-y-6 ${isDark ? '' : 'bg-gray-50 min-h-full'}`}>
        {/* ─── Header ─── */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl shadow-lg shadow-violet-500/20">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className={`text-2xl font-bold ${headerText}`}>User Insights</h2>
              <p className={`text-sm ${subtleText}`}>Monitor how your team uses QuickInsight across the globe</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Data source badge */}
            {usingBackend ? (
              <span className="flex items-center gap-1.5 text-[11px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-200 dark:border-emerald-500/20">
                <Globe className="w-3 h-3" /> Global Database
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-1 rounded-full border border-amber-200 dark:border-amber-500/20">
                Local Only
              </span>
            )}
            <button
              onClick={() => fetchFromBackend()}
              disabled={isLoading}
              className={`flex items-center gap-1.5 text-[12px] font-bold px-3 py-1.5 rounded-lg transition-all border ${isDark ? 'text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border-cyan-500/20' : 'text-cyan-600 bg-cyan-50 hover:bg-cyan-100 border-cyan-200'} disabled:opacity-50`}
            >
              {isLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
            </button>
          </div>
        </div>

        {/* Backend error notice */}
        {backendError && (
          <div className={`text-xs px-3 py-2 rounded-lg border ${isDark ? 'bg-amber-500/10 border-amber-500/20 text-amber-400' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
            ⚠️ {backendError}
          </div>
        )}

        {/* ─── Summary Cards ─── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Total Users', value: totalUsers, icon: <Users className="w-5 h-5" />, color: 'text-violet-500', bg: isDark ? 'bg-violet-500/10' : 'bg-violet-50' },
            { label: 'Active Today', value: activeToday, icon: <Zap className="w-5 h-5" />, color: 'text-emerald-500', bg: isDark ? 'bg-emerald-500/10' : 'bg-emerald-50' },
            { label: 'Total Queries', value: totalQueries, icon: <Sparkles className="w-5 h-5" />, color: 'text-blue-500', bg: isDark ? 'bg-blue-500/10' : 'bg-blue-50' },
            { label: 'Datasets Uploaded', value: totalUploads, icon: <Upload className="w-5 h-5" />, color: 'text-amber-500', bg: isDark ? 'bg-amber-500/10' : 'bg-amber-50' },
          ].map(card => (
            <div key={card.label} className={cardCls}>
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-xl ${card.bg}`}>
                  <span className={card.color}>{card.icon}</span>
                </div>
                <div>
                  <p className={`text-[10px] font-semibold uppercase tracking-wider ${mutedText}`}>{card.label}</p>
                  <p className={`text-2xl font-bold ${headerText}`}>{card.value.toLocaleString()}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ─── View Toggle ─── */}
        <div className="flex gap-2">
          {(['overview', 'activity'] as const).map(v => (
            <button
              key={v}
              onClick={() => setActiveView(v)}
              className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
                activeView === v
                  ? isDark ? 'bg-violet-500/15 text-violet-300 border border-violet-500/30' : 'bg-violet-50 text-violet-700 border border-violet-200'
                  : isDark ? 'text-gray-400 hover:bg-white/[0.05] border border-transparent' : 'text-gray-600 hover:bg-gray-100 border border-transparent'
              }`}
            >
              {v === 'overview' ? '👥 User Overview' : '📋 Activity Feed'}
            </button>
          ))}
        </div>

        {activeView === 'overview' ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* ─── User List ─── */}
            <div className={`${cardCls} lg:col-span-1`}>
              <h3 className={`text-sm font-bold mb-4 flex items-center gap-2 ${headerText}`}>
                <Users className="w-4 h-4 text-violet-500" /> All Users
                <span className={`ml-auto text-xs font-normal ${mutedText}`}>{summaries.length}</span>
              </h3>
              <div className="space-y-1.5 max-h-[500px] overflow-y-auto">
                {summaries.length === 0 ? (
                  <p className={`text-sm text-center py-8 ${mutedText}`}>No user activity recorded yet.</p>
                ) : (
                  summaries.map(s => (
                    <button
                      key={s.userId}
                      onClick={() => setSelectedUser(s.userId === selectedUser ? null : s.userId)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left ${
                        selectedUser === s.userId
                          ? isDark ? 'bg-violet-500/15 border border-violet-500/20' : 'bg-violet-50 border border-violet-200'
                          : isDark ? 'hover:bg-white/[0.04] border border-transparent' : 'hover:bg-gray-50 border border-transparent'
                      }`}
                    >
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0"
                        style={{ backgroundColor: '#7c3aed' }}
                      >
                        {s.userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-sm font-semibold truncate ${headerText}`}>{s.userName}</span>
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold border ${getRoleBadge(s.userRole, isDark)}`}>
                            {getRoleIcon(s.userRole)} {s.userRole}
                          </span>
                        </div>
                        <div className={`text-[11px] ${mutedText}`}>
                          {s.totalActions} actions · Last active {timeAgo(s.lastActive)}
                        </div>
                      </div>
                      <ChevronRight className={`w-4 h-4 shrink-0 transition-transform ${selectedUser === s.userId ? 'rotate-90' : ''} ${mutedText}`} />
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* ─── User Detail ─── */}
            <div className={`${cardCls} lg:col-span-2`}>
              {selectedSummary ? (
                <div className="space-y-5">
                  {/* User header */}
                  <div className="flex items-center gap-4">
                    <div
                      className="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-bold text-lg shadow-lg"
                      style={{ backgroundColor: '#7c3aed' }}
                    >
                      {selectedSummary.userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                    </div>
                    <div>
                      <h3 className={`text-xl font-bold ${headerText}`}>{selectedSummary.userName}</h3>
                      <p className={`text-sm ${subtleText}`}>{selectedSummary.userEmail}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-bold border ${getRoleBadge(selectedSummary.userRole, isDark)}`}>
                          {getRoleIcon(selectedSummary.userRole)} {selectedSummary.userRole}
                        </span>
                        <span className={`text-[10px] ${mutedText}`}>
                          · Joined {new Date(selectedSummary.firstSeen).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Stats grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {[
                      { label: 'Logins', value: selectedSummary.loginCount, icon: '🔑' },
                      { label: 'AI Queries', value: selectedSummary.aiSqlQueries, icon: '✨' },
                      { label: 'Builder Queries', value: selectedSummary.builderQueries, icon: '🔍' },
                      { label: 'Smart Questions', value: selectedSummary.smartQuestions, icon: '💡' },
                      { label: 'Uploads', value: selectedSummary.datasetsUploaded, icon: '📤' },
                      { label: 'Dashboard Pins', value: selectedSummary.dashboardPins, icon: '📌' },
                      { label: 'Alerts Created', value: selectedSummary.alertsCreated, icon: '🔔' },
                      { label: 'Active Days', value: selectedSummary.activeDays, icon: '📅' },
                    ].map(stat => (
                      <div
                        key={stat.label}
                        className={`rounded-xl p-3 border ${isDark ? 'bg-white/[0.03] border-white/[0.06]' : 'bg-gray-50 border-gray-200'}`}
                      >
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-sm">{stat.icon}</span>
                          <span className={`text-[10px] font-semibold uppercase tracking-wider ${mutedText}`}>{stat.label}</span>
                        </div>
                        <p className={`text-xl font-bold ${headerText}`}>{stat.value}</p>
                      </div>
                    ))}
                  </div>

                  {/* Engagement bar */}
                  <div className={`rounded-xl p-4 border ${isDark ? 'bg-white/[0.02] border-white/[0.06]' : 'bg-gray-50 border-gray-200'}`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`text-xs font-semibold ${headerText}`}>Engagement Score</span>
                      <span className={`text-xs font-bold ${
                        selectedSummary.avgActionsPerDay >= 10 ? 'text-emerald-500' :
                        selectedSummary.avgActionsPerDay >= 5 ? 'text-amber-500' : 'text-gray-400'
                      }`}>
                        {selectedSummary.avgActionsPerDay} actions/day avg
                      </span>
                    </div>
                    <div className={`w-full h-2 rounded-full ${isDark ? 'bg-white/[0.06]' : 'bg-gray-200'}`}>
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          selectedSummary.avgActionsPerDay >= 10 ? 'bg-emerald-500' :
                          selectedSummary.avgActionsPerDay >= 5 ? 'bg-amber-500' : 'bg-gray-400'
                        }`}
                        style={{ width: `${Math.min(100, selectedSummary.avgActionsPerDay * 5)}%` }}
                      />
                    </div>
                  </div>

                  {/* Recent activity for this user */}
                  <div>
                    <h4 className={`text-xs font-semibold uppercase tracking-wider mb-3 ${mutedText}`}>Recent Activity</h4>
                    <div className="space-y-1 max-h-60 overflow-y-auto">
                      {selectedActivities.slice(0, 30).map((a, i) => {
                        const meta = ACTION_LABELS[a.action] || { label: a.action, icon: <Activity className="w-3.5 h-3.5" />, color: 'text-gray-400' };
                        return (
                          <div key={i} className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-gray-50'}`}>
                            <span className={meta.color}>{meta.icon}</span>
                            <span className={`text-sm flex-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                              {meta.label}
                              {a.details && <span className={`ml-1 ${mutedText}`}>· {a.details}</span>}
                            </span>
                            <span className={`text-[10px] font-mono ${mutedText}`}>{timeAgo(a.timestamp)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className={`flex flex-col items-center justify-center h-80 ${mutedText}`}>
                  <Users className="w-12 h-12 mb-3 opacity-30" />
                  <p className="text-sm font-medium">Select a user to view their insights</p>
                  <p className="text-xs mt-1">Click on a user from the list to see detailed activity</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* ─── Activity Feed View ─── */
          <div className={cardCls}>
            <h3 className={`text-sm font-bold mb-4 flex items-center gap-2 ${headerText}`}>
              <Activity className="w-4 h-4 text-violet-500" /> Recent Activity Feed
              <span className={`ml-auto text-xs font-normal ${mutedText}`}>{recentActivities.length} events</span>
            </h3>
            <div className="space-y-1 max-h-[600px] overflow-y-auto">
              {recentActivities.length === 0 ? (
                <p className={`text-sm text-center py-12 ${mutedText}`}>
                  No activity recorded yet. User actions will appear here as they interact with QuickInsight.
                </p>
              ) : (
                recentActivities.map((a, i) => {
                  const meta = ACTION_LABELS[a.action] || { label: a.action, icon: <Activity className="w-3.5 h-3.5" />, color: 'text-gray-400' };
                  return (
                    <div key={i} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${isDark ? 'hover:bg-white/[0.03]' : 'hover:bg-gray-50'}`}>
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-[10px] shrink-0"
                        style={{ backgroundColor: '#7c3aed' }}
                      >
                        {a.userName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <span className={meta.color}>{meta.icon}</span>
                      <div className="flex-1 min-w-0">
                        <span className={`text-sm font-semibold ${headerText}`}>{a.userName}</span>
                        <span className={`text-sm ml-1.5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                          {meta.label.toLowerCase()}
                        </span>
                        {a.details && <span className={`text-sm ml-1 ${mutedText}`}>· {a.details}</span>}
                      </div>
                      <span className={`text-[10px] font-mono shrink-0 ${mutedText}`}>{timeAgo(a.timestamp)}</span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
