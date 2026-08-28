import React, { useState } from 'react';
import { Layout, Database, Play, Search, Upload, X, BarChart2, MessageSquare, LogOut, Users, Crown, Pencil, Eye, GitMerge, Wrench, Sparkles, KeyRound, Check, AlertTriangle, Loader2, ChevronRight, Lightbulb, Bell, Activity, Zap, Shield, Gamepad2, Settings, Wand2, Beaker, SlidersHorizontal } from 'lucide-react';
import { Tab, UserRole } from '../types';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { useAlertStore } from '../store/useAlertStore';
import { Tooltip } from './Tooltip';
import { PageInfoButton, PageKey } from './PageInfoButton';
import classNames from 'clsx';
import { useTheme } from './ThemeProvider';
import { useAppStore } from '../store/useAppStore';

interface SidebarProps {
    activeTab: Tab;
    onTabChange: (tab: Tab) => void;
    onToggle: () => void;
    onOpenUserManagement?: () => void;
    hasVisualResult?: boolean;
    onDataStory?: () => void;
    onOpenTabManager?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, onToggle, onOpenUserManagement, hasVisualResult, onDataStory, onOpenTabManager }) => {
    const { currentUser, logout } = useAuthStore();
    const { unreadCount } = useAlertStore();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const userRole = currentUser?.role || UserRole.VIEWER;
    const perms = ROLE_PERMISSIONS[userRole];
    const hiddenTabs = useAppStore((s: any) => s.hiddenTabs) || [];

    // Change Password modal state
    const [showChangePw, setShowChangePw] = useState(false);
    const [pwCurrent, setPwCurrent] = useState('');
    const [pwNew, setPwNew] = useState('');
    const [pwConfirm, setPwConfirm] = useState('');
    const [pwError, setPwError] = useState('');
    const [pwSuccess, setPwSuccess] = useState(false);
    const [pwLoading, setPwLoading] = useState(false);

    // Explore Data collapsible state
    const exploreDataTabs = [Tab.COLUMN_MAPPING, Tab.ETL, Tab.DATA_STUDIO, Tab.SCHEMA, Tab.DATASET_SUMMARY];
    const isExploreActive = exploreDataTabs.includes(activeTab);
    const [exploreDataOpen, setExploreDataOpen] = useState(isExploreActive);

    const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002/api';

    const handleChangePassword = async () => {
        setPwError('');
        setPwSuccess(false);
        if (!pwCurrent || !pwNew || !pwConfirm) { setPwError('All fields are required'); return; }
        if (pwNew.length < 6) { setPwError('New password must be at least 6 characters'); return; }
        if (pwNew !== pwConfirm) { setPwError('New passwords do not match'); return; }
        if (pwNew === pwCurrent) { setPwError('New password must be different from current'); return; }

        setPwLoading(true);
        try {
            const token = localStorage.getItem('qi_token');
            const res = await fetch(`${API_BASE}/auth/change-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setPwError(data.error || 'Failed to change password');
            } else {
                setPwSuccess(true);
                setPwCurrent(''); setPwNew(''); setPwConfirm('');
                setTimeout(() => { setShowChangePw(false); setPwSuccess(false); }, 2000);
            }
        } catch {
            setPwError('Could not connect to server');
        }
        setPwLoading(false);
    };

    const dataSection = [
        { id: Tab.UPLOAD, label: 'Data Source', icon: Upload, requiresUpload: true, tooltip: 'Upload CSV/Excel files or connect to databases like SQL Server to import your data.' },
    ];

    // Dataset preparation lives in one workspace; legacy route IDs remain supported for saved links.
    const exploreDataItems = [
        { id: Tab.DATASET_SUMMARY, label: 'Dataset Workspace', icon: BarChart2, tooltip: 'Explore raw and cleaned data, review column mapping and schema, inspect automated cleaning, and use hands-on data studio tools.' },
    ];

    const analysisSection = [
        { id: Tab.BUILDER, label: 'Question Builder', icon: Search, requiresCreateVisuals: true, tooltip: 'A simplified natural-language-style builder: "Show me [metric] by [dimension]" with intuitive dropdowns.' },
        { id: Tab.AI_SQL, label: 'AI SQL', icon: Sparkles, requiresCreateVisuals: true, tooltip: 'Ask questions in natural language — AI SQL selects the right GPT-5.6 reasoning tier, validates read-only SQL, and creates a visual result.' },
        { id: Tab.GAME, label: 'GAFS Challenge', icon: Gamepad2, tooltip: 'Every chart is 4 steps: split it up, add something up, filter the rows, put them in order. Learn them by helping a small farm find out what makes money.' },
        { id: Tab.QUICK_INSIGHTS, label: 'Discover', icon: Zap, requiresCreateVisuals: true, tooltip: 'Automatic insight discovery — the moment your data loads, it surfaces what stands out (drops, spikes, concentration, outliers), explains the likely root cause, and writes an executive summary. No question required.' },
        { id: Tab.SMART_QUESTIONS, label: 'Smart Insights', icon: Lightbulb, requiresCreateVisuals: true, tooltip: 'AI-curated questions tailored to your dataset. Click any card to instantly run the analysis.' },
        ...(hasVisualResult ? [{ id: Tab.VISUAL_PREVIEW, label: 'Visual Result', icon: BarChart2, requiresCreateVisuals: true, tooltip: 'View your latest AI SQL result — chart, table, SQL, and formatting controls.' }] : []),
        { id: Tab.DERIVED_COLUMNS, label: 'Derived Columns', icon: Lightbulb, requiresCreateVisuals: true, tooltip: 'AI-suggested and custom derived columns — create new business metrics from your data.' },
        { id: Tab.CUSTOM_QUESTIONS, label: 'Custom Questions', icon: Wrench, requiresManageQuestions: true, tooltip: 'Build custom analytical questions with SQL. Admin only.' },
    ];
    const viewSection = [
        { id: Tab.DASHBOARD, label: 'Dashboard', icon: Layout, tooltip: 'View all your pinned analyses in a dashboard layout with drag-and-drop arrangement.' },
        { id: Tab.ALERTS, label: 'Monitoring', icon: Bell, badge: unreadCount, tooltip: 'Create business rules to monitor metrics. Get alerted when thresholds are crossed or trends change.' },
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.USER_INSIGHTS, label: 'User Insights', icon: Activity, requiresManageUsers: true, tooltip: 'View usage analytics per user — logins, queries, uploads, and engagement scores. Admin only.' }] : []),
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.BENCHMARK, label: 'Benchmark Lab', icon: Beaker, tooltip: 'Run the versioned 150-question AI SQL accuracy benchmark and export reproducible evidence. Admin only.' }] : []),
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.AI_SQL_ENGINES, label: 'AI SQL Engines', icon: SlidersHorizontal, tooltip: 'Control global AI SQL reasoning, verification, and repair stages. Admin only.' }] : []),
    ];

    const filterItems = (items: any[]) => items.filter(item => {
        if (item.requiresUpload && !perms.canUpload) return false;
        if (item.requiresEditSchema && !perms.canEditSchema) return false;
        if (item.requiresCreateVisuals && !perms.canCreateVisuals) return false;
        if (item.requiresManageQuestions && !perms.canManageQuestions) return false;
        // Admin-controlled global tab visibility
        if (hiddenTabs.includes(item.id)) return false;
        return true;
    });

    const getRoleIcon = (role: UserRole) => {
        switch (role) {
            case UserRole.ADMIN: return <Crown className="w-3 h-3" />;
            case UserRole.CONTRIBUTOR: return <Pencil className="w-3 h-3" />;
            case UserRole.VIEWER: return <Eye className="w-3 h-3" />;
        }
    };

    const getRoleBadgeClasses = (role: UserRole) => {
        if (isDark) {
            switch (role) {
                case UserRole.ADMIN: return 'bg-rose-500/15 text-rose-400 border-rose-500/20';
                case UserRole.CONTRIBUTOR: return 'bg-violet-500/15 text-violet-400 border-violet-500/20';
                case UserRole.VIEWER: return 'bg-cyan-500/15 text-cyan-400 border-cyan-500/20';
            }
        }
        switch (role) {
            case UserRole.ADMIN: return 'bg-rose-50 text-rose-600 border-rose-200';
            case UserRole.CONTRIBUTOR: return 'bg-violet-50 text-violet-600 border-violet-200';
            case UserRole.VIEWER: return 'bg-sky-50 text-sky-600 border-sky-200';
        }
    };

    const renderNavItem = (item: any) => {
        const isActive = activeTab === item.id;
        return (
            <Tooltip key={item.id} text={item.tooltip || ''} position="right" delay={400}>
                <button
                    onClick={() => onTabChange(item.id)}
                    className={classNames(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 group relative text-[13px] font-medium",
                        isActive
                            ? isDark
                                ? "bg-gradient-to-r from-violet-500/15 to-indigo-500/10 text-violet-300 shadow-sm shadow-violet-500/10"
                                : "bg-gradient-to-r from-violet-50 to-indigo-50 text-violet-700 shadow-sm shadow-violet-500/5"
                            : isDark
                                ? "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 hover:translate-x-0.5"
                                : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 hover:translate-x-0.5"
                    )}
                >
                    {/* Active left accent bar — gradient */}
                    {isActive && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-gradient-to-b from-violet-400 to-indigo-500 sidebar-active-indicator" />
                    )}

                    <div className={classNames(
                        "w-7 h-7 rounded-lg flex items-center justify-center transition-all duration-200 shrink-0",
                        isActive
                            ? isDark ? "bg-violet-500/20 text-violet-400" : "bg-violet-100 text-violet-600"
                            : isDark ? "bg-white/[0.04] text-gray-500 group-hover:bg-white/[0.06] group-hover:text-gray-300" : "bg-gray-100 text-gray-400 group-hover:bg-gray-200 group-hover:text-gray-600"
                    )}>
                        <item.icon className="w-[15px] h-[15px]" />
                    </div>
                    <span>{item.label}</span>
                    {/* Info button — appears on hover */}
                    <span
                        className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity duration-200"
                        onClick={e => e.stopPropagation()}
                    >
                        <PageInfoButton pageKey={item.id as PageKey} />
                    </span>
                    {item.badge > 0 && (
                        <span className="ml-auto flex items-center gap-1">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                            </span>
                            <span className={`text-[10px] font-bold ${isDark ? 'text-red-400' : 'text-red-500'}`}>{item.badge}</span>
                        </span>
                    )}
                </button>
            </Tooltip>
        );
    };

    const renderSection = (label: string, items: any[]) => {
        const filtered = filterItems(items);
        if (filtered.length === 0) return null;
        return (
            <div className="mb-1">
                <div className="px-3 mb-2 flex items-center gap-2">
                    <div className={`h-px flex-1 ${isDark ? 'bg-gradient-to-r from-violet-500/20 to-transparent' : 'bg-gradient-to-r from-violet-200 to-transparent'}`} />
                    <span className={`text-[10px] font-bold uppercase tracking-[0.12em] ${isDark ? 'text-gray-500' : 'text-gray-400'
                        }`}>
                        {label}
                    </span>
                    <div className={`h-px flex-1 ${isDark ? 'bg-gradient-to-l from-violet-500/20 to-transparent' : 'bg-gradient-to-l from-violet-200 to-transparent'}`} />
                </div>
                <div className="space-y-0.5">
                    {filtered.map(renderNavItem)}
                </div>
            </div>
        );
    };

    // Render the "Explore Data" collapsible group
    const renderExploreDataGroup = () => {
        const filteredExplore = filterItems(exploreDataItems);
        if (filteredExplore.length === 0) return null;
        return (
            <div className="space-y-0.5">
                <button
                    onClick={() => setExploreDataOpen(!exploreDataOpen)}
                    className={classNames(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-150 text-[13px] font-medium relative",
                        isExploreActive
                            ? isDark ? "bg-violet-500/15 text-violet-300" : "bg-violet-50 text-violet-700"
                            : isDark ? "text-gray-400 hover:bg-white/[0.05] hover:text-gray-200" : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                    )}
                >
                    {isExploreActive && (
                        <div className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full ${isDark ? 'bg-violet-400' : 'bg-violet-600'}`} />
                    )}
                    <Database className={classNames(
                        "w-[17px] h-[17px] transition-colors duration-150",
                        isExploreActive ? isDark ? "text-violet-400" : "text-violet-600" : isDark ? "text-gray-500" : "text-gray-400"
                    )} />
                    <span className="flex-1 text-left">Explore Data</span>
                    <ChevronRight className={classNames(
                        "w-3.5 h-3.5 transition-transform duration-200",
                        exploreDataOpen ? "rotate-90" : "",
                        isDark ? "text-gray-600" : "text-gray-400"
                    )} />
                </button>
                {exploreDataOpen && (
                    <div className={`ml-4 pl-3 space-y-0.5 border-l ${isDark ? 'border-white/[0.06]' : 'border-gray-200'}`}>
                        {filteredExplore.map(renderNavItem)}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="app-sidebar-content flex flex-col h-full p-3">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 px-1">
                <div className="flex items-center gap-2.5">
                    <div className="relative">
                        <div className={`absolute -inset-0.5 rounded-xl ${isDark ? 'bg-gradient-to-br from-violet-500/30 to-indigo-500/30' : 'bg-gradient-to-br from-violet-200 to-indigo-200'} blur-sm`} />
                        <img src="/logo.jpg" alt="QuickInsight" className="relative w-8 h-8 rounded-lg object-cover shadow-sm ring-1 ring-white/10" />
                    </div>
                    <div>
                        <span className="font-extrabold text-[15px] tracking-tight block leading-tight gradient-text-brand">QuickInsight</span>
                        <span className={`text-[10px] font-medium tracking-wide ${isDark ? 'text-gray-500' : 'text-gray-400'
                            }`}>Analytics Platform</span>
                    </div>
                </div>
                <button
                    onClick={onToggle}
                    className={`p-1.5 rounded-lg transition-all duration-200 ${isDark ? 'hover:bg-white/10 text-gray-500 hover:text-gray-300 hover:rotate-90' : 'hover:bg-gray-100 text-gray-400 hover:text-gray-600 hover:rotate-90'
                        }`}
                    title="Toggle Sidebar"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Divider — gradient line */}
            <div className={`mx-2 mb-3 h-px ${isDark ? 'bg-gradient-to-r from-transparent via-white/[0.08] to-transparent' : 'bg-gradient-to-r from-transparent via-gray-200 to-transparent'}`} />

            {/* Navigation */}
            <nav className="flex-1 min-h-0 overflow-y-auto space-y-3 stagger-in">
                {/* Data section: Upload + collapsible Explore Data */}
                <div className="mb-1">
                    <div className="px-3 mb-2 flex items-center gap-2">
                        <div className={`h-px flex-1 ${isDark ? 'bg-gradient-to-r from-violet-500/20 to-transparent' : 'bg-gradient-to-r from-violet-200 to-transparent'}`} />
                        <span className={`text-[10px] font-bold uppercase tracking-[0.12em] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            Data
                        </span>
                        <div className={`h-px flex-1 ${isDark ? 'bg-gradient-to-l from-violet-500/20 to-transparent' : 'bg-gradient-to-l from-violet-200 to-transparent'}`} />
                    </div>
                    <div className="space-y-0.5">
                        {filterItems(dataSection).map(renderNavItem)}
                        {renderExploreDataGroup()}
                    </div>
                </div>
                {renderSection('Analysis', analysisSection)}
                {/* Data Story special button */}
                {onDataStory && perms.canCreateVisuals && !hiddenTabs.includes('DATA_STORY') && (
                    <div className="px-2 mb-2">
                        <button
                            onClick={onDataStory}
                            className={classNames(
                                'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-bold transition-all duration-200 border',
                                isDark
                                    ? 'bg-gradient-to-r from-indigo-500/10 to-purple-500/10 text-indigo-300 border-indigo-500/20 hover:from-indigo-500/20 hover:to-purple-500/20 hover:border-indigo-400/30'
                                    : 'bg-gradient-to-r from-indigo-50 to-purple-50 text-indigo-700 border-indigo-200 hover:from-indigo-100 hover:to-purple-100'
                            )}
                        >
                            <span className="text-base">{'\u{1F4CA}'}</span>
                            <span>Data Story</span>
                            <span className={`ml-auto text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${isDark ? 'bg-indigo-500/20 text-indigo-300' : 'bg-indigo-100 text-indigo-600'}`}>New</span>
                        </button>
                    </div>
                )}
                {renderSection('Views', viewSection)}
            </nav>

            {/* User Section */}
            <div className="shrink-0 mt-auto pt-2 space-y-1.5">
                <div className={`mx-2 mb-2 h-px ${isDark ? 'bg-gradient-to-r from-transparent via-white/[0.08] to-transparent' : 'bg-gradient-to-r from-transparent via-gray-200 to-transparent'}`} />

                {perms.canManageUsers && onOpenUserManagement && (
                    <button
                        onClick={onOpenUserManagement}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-[13px] font-medium ${isDark ? 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 hover:translate-x-0.5' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 hover:translate-x-0.5'
                            }`}
                    >
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isDark ? 'bg-white/[0.04] text-gray-500' : 'bg-gray-100 text-gray-400'}`}>
                            <Users className="w-[15px] h-[15px]" />
                        </div>
                        <span>Manage Users</span>
                    </button>
                )}

                {userRole === UserRole.ADMIN && onOpenTabManager && (
                    <button
                        onClick={onOpenTabManager}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-[13px] font-medium ${isDark ? 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200 hover:translate-x-0.5' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 hover:translate-x-0.5'
                            }`}
                    >
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isDark ? 'bg-white/[0.04] text-gray-500' : 'bg-gray-100 text-gray-400'}`}>
                            <Settings className="w-[15px] h-[15px]" />
                        </div>
                        <span>Manage Tabs</span>
                    </button>
                )}

                {currentUser && (
                    <div className={`rounded-xl p-3 border transition-all ${isDark ? 'bg-gradient-to-br from-white/[0.03] to-white/[0.01] border-white/[0.06] hover:border-violet-500/20' : 'bg-gradient-to-br from-gray-50 to-white border-gray-200 hover:border-violet-200'
                        }`}>
                        <div className="flex items-center gap-2.5">
                            {/* Avatar with gradient ring */}
                            <div className="relative shrink-0">
                                <div className="absolute -inset-0.5 rounded-full bg-gradient-to-br from-violet-500 to-indigo-500 opacity-60" />
                                <div
                                    className="relative w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs shadow-md"
                                    style={{ backgroundColor: currentUser.avatar || '#7c3aed' }}
                                >
                                    {currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                                </div>
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-bold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{currentUser.name}</div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-bold border ${getRoleBadgeClasses(currentUser.role)}`}>
                                        {getRoleIcon(currentUser.role)}
                                        {ROLE_PERMISSIONS[currentUser.role].label}
                                    </span>
                                </div>
                            </div>
                            <button
                                onClick={() => { setShowChangePw(true); setPwError(''); setPwSuccess(false); setPwCurrent(''); setPwNew(''); setPwConfirm(''); }}
                                className={`p-1.5 rounded-lg transition-all duration-200 shrink-0 ${isDark ? 'text-gray-500 hover:text-violet-400 hover:bg-violet-500/10' : 'text-gray-400 hover:text-violet-500 hover:bg-violet-50'
                                    }`}
                                title="Change Password"
                            >
                                <KeyRound className="w-4 h-4" />
                            </button>
                            <button
                                onClick={async () => await logout()}
                                className={`p-1.5 rounded-lg transition-all duration-200 shrink-0 ${isDark ? 'text-gray-500 hover:text-red-400 hover:bg-red-500/10' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'
                                    }`}
                                title="Sign Out"
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}

                <div className="mt-1.5 px-3 py-1 flex items-center justify-center gap-2">
                    <span className={`text-[10px] font-mono ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>v3.0</span>
                    <span className={`text-[10px] ${isDark ? 'text-gray-700' : 'text-gray-300'}`}>·</span>
                    <button
                        onClick={() => onTabChange(Tab.LEGAL)}
                        className={`text-xs font-semibold transition-colors flex items-center gap-1.5 rounded-md px-1.5 py-1 ${isDark ? 'text-slate-400 hover:text-indigo-300 hover:bg-white/[0.05]' : 'text-slate-600 hover:text-indigo-700 hover:bg-indigo-50'}`}
                    >
                        <Shield className="w-3.5 h-3.5" />
                        Privacy & Terms
                    </button>
                </div>
            </div>

            {/* ── Change Password Modal ── */}
            {showChangePw && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
                    <div className={`w-full max-w-sm mx-4 rounded-2xl shadow-2xl border p-6 ${isDark ? 'bg-[#1a1f2e] border-white/10' : 'bg-white border-gray-200'}`}>
                        <div className="flex items-center gap-3 mb-5">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
                                <KeyRound className="w-5 h-5 text-white" />
                            </div>
                            <div>
                                <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Change Password</h3>
                                <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{currentUser?.email}</p>
                            </div>
                        </div>

                        <div className="space-y-3">
                            <div>
                                <label className={`text-[10px] font-semibold uppercase tracking-wider block mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Current Password</label>
                                <input
                                    type="password" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)}
                                    className={`w-full rounded-lg px-3 py-2.5 text-sm border focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
                                        }`}
                                    placeholder="Enter current password"
                                />
                            </div>
                            <div>
                                <label className={`text-[10px] font-semibold uppercase tracking-wider block mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>New Password</label>
                                <input
                                    type="password" value={pwNew} onChange={e => setPwNew(e.target.value)}
                                    className={`w-full rounded-lg px-3 py-2.5 text-sm border focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
                                        }`}
                                    placeholder="Enter new password (min 6 chars)"
                                />
                            </div>
                            <div>
                                <label className={`text-[10px] font-semibold uppercase tracking-wider block mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Confirm New Password</label>
                                <input
                                    type="password" value={pwConfirm} onChange={e => setPwConfirm(e.target.value)}
                                    className={`w-full rounded-lg px-3 py-2.5 text-sm border focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
                                        }`}
                                    placeholder="Re-enter new password"
                                    onKeyDown={e => e.key === 'Enter' && handleChangePassword()}
                                />
                            </div>
                        </div>

                        {pwError && (
                            <div className="mt-3 flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {pwError}
                            </div>
                        )}
                        {pwSuccess && (
                            <div className="mt-3 flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-3 py-2">
                                <Check className="w-3.5 h-3.5 shrink-0" /> Password changed successfully!
                            </div>
                        )}

                        <div className="flex gap-2 mt-5">
                            <button
                                onClick={() => setShowChangePw(false)}
                                className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-medium border transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-gray-300 hover:bg-white/[0.08]' : 'bg-gray-50 border-gray-200 text-gray-600 hover:bg-gray-100'
                                    }`}
                            >Cancel</button>
                            <button
                                onClick={handleChangePassword}
                                disabled={pwLoading || pwSuccess}
                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-500 hover:to-purple-500 text-white shadow-lg shadow-violet-500/20 transition-all disabled:opacity-50"
                            >
                                {pwLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {pwLoading ? 'Changing...' : 'Update Password'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
