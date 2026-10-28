import React, { useId, useState } from 'react';
import { LayoutGroup, motion } from 'framer-motion';
import { Layout, Database, Play, Search, Upload, X, BarChart2, MessageSquare, LogOut, Users, Crown, Pencil, Eye, GitMerge, Wrench, Sparkles, KeyRound, Check, AlertTriangle, Loader2, ChevronRight, Lightbulb, Bell, Activity, Zap, Shield, Gamepad2, Settings, Wand2, Beaker, SlidersHorizontal, Table2, BookOpen, Compass } from 'lucide-react';
import { Tab, UserRole } from '../types';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { useAlertStore } from '../store/useAlertStore';
import { Tooltip } from './Tooltip';
import { PageInfoButton, PageKey } from './PageInfoButton';
import classNames from 'clsx';
import { useTheme } from './ThemeProvider';
import { useAppStore } from '../store/useAppStore';
import { isGuestPrimaryTab, isGuestUser } from '../services/guestAccessPolicy';

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
    const isGuest = isGuestUser(currentUser);
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

    // Legacy dataset-preparation routes all live inside Dataset Workspace, so
    // that nav item stays highlighted while any of them is open.
    const exploreDataTabs = [Tab.COLUMN_MAPPING, Tab.ETL, Tab.DATA_STUDIO, Tab.SCHEMA, Tab.DATASET_SUMMARY];
    const isExploreActive = exploreDataTabs.includes(activeTab);
    // Two Sidebars can be mounted at once (desktop + mobile drawer); a per-instance
    // LayoutGroup keeps each one's sliding highlight independent.
    const navGroupId = useId();

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

    // Navigation is grouped by the job the user is doing. Tab ids, labels,
    // permissions and guest filtering are unchanged — only grouping, order
    // and icons differ, so every page and saved link behaves as before.
    const dataSection = [
        { id: Tab.UPLOAD, label: 'Data Source', icon: Upload, requiresUpload: true, tooltip: 'Upload CSV/Excel files or connect to databases like SQL Server to import your data.' },
        // Dataset preparation lives in one workspace; legacy route IDs remain supported for saved links.
        { id: Tab.DATASET_SUMMARY, label: 'Dataset Workspace', icon: Table2, activeAlso: exploreDataTabs, tooltip: 'Explore raw and cleaned data, review column mapping and schema, inspect automated cleaning, and use hands-on data studio tools.' },
        { id: Tab.DERIVED_COLUMNS, label: 'Derived Columns', icon: Wand2, requiresCreateVisuals: true, tooltip: 'AI-suggested and custom derived columns — create new business metrics from your data.' },
    ];

    const askSection = [
        { id: Tab.BUILDER, label: 'Question Builder', icon: Search, requiresCreateVisuals: true, tooltip: 'A simplified natural-language-style builder: "Show me [metric] by [dimension]" with intuitive dropdowns.' },
        { id: Tab.AI_SQL, label: 'AI SQL', icon: Sparkles, requiresCreateVisuals: true, tooltip: 'Ask questions in natural language — AI SQL selects the right GPT-5.6 reasoning tier, validates read-only SQL, and creates a visual result.' },
        ...(hasVisualResult ? [{ id: Tab.VISUAL_PREVIEW, label: 'Visual Result', icon: BarChart2, requiresCreateVisuals: true, tooltip: 'View your latest AI SQL result — chart, table, SQL, and formatting controls.' }] : []),
        { id: Tab.CUSTOM_QUESTIONS, label: 'Custom Questions', icon: Wrench, requiresManageQuestions: true, tooltip: 'Build custom analytical questions with SQL. Admin only.' },
    ];

    const insightSection = [
        { id: Tab.QUICK_INSIGHTS, label: 'Discover', icon: Compass, requiresCreateVisuals: true, tooltip: 'Automatic insight discovery — the moment your data loads, it surfaces what stands out (drops, spikes, concentration, outliers), explains the likely root cause, and writes an executive summary. No question required.' },
        { id: Tab.SMART_QUESTIONS, label: 'Smart Insights', icon: Lightbulb, requiresCreateVisuals: true, tooltip: 'AI-curated questions tailored to your dataset. Click any card to instantly run the analysis.' },
        { id: Tab.GAME, label: 'GAFS Challenge', icon: Gamepad2, tooltip: 'Every chart is 4 steps: split it up, add something up, filter the rows, put them in order. Learn them by helping a small farm find out what makes money.' },
    ];

    const viewSection = [
        { id: Tab.DASHBOARD, label: 'Dashboard', icon: Layout, tooltip: 'View all your pinned analyses in a dashboard layout with drag-and-drop arrangement.' },
        { id: Tab.ALERTS, label: 'Monitoring', icon: Bell, badge: unreadCount, tooltip: 'Create business rules to monitor metrics. Get alerted when thresholds are crossed or trends change.' },
    ];

    const adminSection = [
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.USER_INSIGHTS, label: 'User Insights', icon: Activity, requiresManageUsers: true, tooltip: 'View usage analytics per user — logins, queries, uploads, and engagement scores. Admin only.' }] : []),
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.BENCHMARK, label: 'Benchmark Lab', icon: Beaker, tooltip: 'Run the versioned 150-question AI SQL accuracy benchmark and export reproducible evidence. Admin only.' }] : []),
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.AI_SQL_ENGINES, label: 'AI SQL Engines', icon: SlidersHorizontal, tooltip: 'Control global AI SQL reasoning, verification, and repair stages. Admin only.' }] : []),
    ];

    const filterItems = (items: any[]) => items.filter(item => {
        // Guest contributors always receive the same intentionally small
        // onboarding navigation, independent of admin tab customisation.
        if (isGuest) return isGuestPrimaryTab(item.id);
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
        const isActive = activeTab === item.id || (item.activeAlso?.includes(activeTab) ?? false);
        return (
            <Tooltip key={item.id} text={item.tooltip || ''} position="right" delay={400}>
                <button
                    onClick={() => onTabChange(item.id)}
                    aria-current={isActive ? 'page' : undefined}
                    className={classNames(
                        "w-full flex items-center gap-3 px-3 py-2 rounded-xl transition-colors duration-150 group relative text-[13px] font-medium",
                        isActive
                            ? isDark ? "text-violet-200" : "text-violet-700"
                            : isDark
                                ? "text-gray-400 hover:bg-white/[0.04] hover:text-gray-200"
                                : "text-gray-600 hover:bg-gray-100/80 hover:text-gray-900"
                    )}
                >
                    {/* Active highlight glides between items (shared layout animation). */}
                    {isActive && (
                        <>
                            <motion.span
                                layoutId="qi-nav-active-pill"
                                className="qi-nav-active-pill"
                                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.8 }}
                                aria-hidden="true"
                            />
                            <motion.span
                                layoutId="qi-nav-active-bar"
                                className="qi-nav-active-bar"
                                transition={{ type: 'spring', stiffness: 520, damping: 40, mass: 0.8 }}
                                aria-hidden="true"
                            />
                        </>
                    )}

                    <span className={classNames(
                        "relative w-7 h-7 rounded-lg flex items-center justify-center transition-colors duration-150 shrink-0",
                        isActive
                            ? isDark ? "bg-violet-500/20 text-violet-300" : "bg-white text-violet-600 shadow-sm"
                            : isDark ? "bg-white/[0.04] text-gray-500 group-hover:bg-white/[0.07] group-hover:text-gray-300" : "bg-gray-100 text-gray-400 group-hover:bg-white group-hover:text-gray-600"
                    )}>
                        <item.icon className="w-[15px] h-[15px]" />
                    </span>
                    <span className="relative">{item.label}</span>
                    {/* Info button — appears on hover */}
                    <span
                        className="relative ml-auto opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-150"
                        onClick={e => e.stopPropagation()}
                    >
                        <PageInfoButton pageKey={item.id as PageKey} />
                    </span>
                    {item.badge > 0 && (
                        <span className="relative ml-auto flex items-center gap-1">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
                            </span>
                            <span className={`text-[11px] font-bold ${isDark ? 'text-red-400' : 'text-red-500'}`}>{item.badge}</span>
                        </span>
                    )}
                </button>
            </Tooltip>
        );
    };

    const renderSectionHeading = (label: string) => (
        <div className={`px-3 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {label}
        </div>
    );

    const renderSection = (label: string, items: any[]) => {
        const filtered = filterItems(items);
        if (filtered.length === 0) return null;
        return (
            <div role="group" aria-label={label}>
                {renderSectionHeading(label)}
                <div className="space-y-0.5">
                    {filtered.map(renderNavItem)}
                </div>
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
                        <span className={`text-[11px] font-medium tracking-wide ${isDark ? 'text-gray-500' : 'text-gray-400'
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
            <LayoutGroup id={navGroupId}>
            <nav className="flex-1 min-h-0 overflow-y-auto space-y-4 stagger-in" aria-label="Main">
                {renderSection('Data', dataSection)}
                {renderSection('Ask', askSection)}
                {renderSection('Insights', insightSection)}
                {/* Data Story special button */}
                {!isGuest && onDataStory && perms.canCreateVisuals && !hiddenTabs.includes('DATA_STORY') && (
                    <div className="px-1">
                        <button
                            onClick={onDataStory}
                            className={classNames(
                                'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-colors duration-150 border',
                                isDark
                                    ? 'bg-gradient-to-r from-violet-500/10 to-indigo-500/5 text-violet-200 border-violet-500/20 hover:from-violet-500/20 hover:to-indigo-500/10 hover:border-violet-400/30'
                                    : 'bg-gradient-to-r from-violet-50 to-indigo-50 text-violet-700 border-violet-200 hover:from-violet-100 hover:to-indigo-100'
                            )}
                        >
                            <span className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isDark ? 'bg-violet-500/20 text-violet-300' : 'bg-white text-violet-600 shadow-sm'}`}>
                                <BookOpen className="w-[15px] h-[15px]" />
                            </span>
                            <span>Data Story</span>
                            <span className={`ml-auto text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ${isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}>New</span>
                        </button>
                    </div>
                )}
                {renderSection('Share & monitor', viewSection)}
                {renderSection('Admin', adminSection)}
            </nav>
            </LayoutGroup>

            {/* User Section */}
            <div className="shrink-0 mt-auto pt-2 space-y-1.5">
                <div className={`mx-2 mb-2 h-px ${isDark ? 'bg-gradient-to-r from-transparent via-white/[0.08] to-transparent' : 'bg-gradient-to-r from-transparent via-gray-200 to-transparent'}`} />

                {perms.canManageUsers && onOpenUserManagement && (
                    <button
                        onClick={onOpenUserManagement}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-[13px] font-medium ${isDark ? 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
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
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-200 text-[13px] font-medium ${isDark ? 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
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
                                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-bold border ${getRoleBadgeClasses(currentUser.role)}`}>
                                        {getRoleIcon(currentUser.role)}
                                        {isGuest ? 'Guest Contributor' : ROLE_PERMISSIONS[currentUser.role].label}
                                    </span>
                                </div>
                            </div>
                            {!isGuest && (
                                <button
                                    onClick={() => { setShowChangePw(true); setPwError(''); setPwSuccess(false); setPwCurrent(''); setPwNew(''); setPwConfirm(''); }}
                                    className={`p-1.5 rounded-lg transition-all duration-200 shrink-0 ${isDark ? 'text-gray-500 hover:text-violet-400 hover:bg-violet-500/10' : 'text-gray-400 hover:text-violet-500 hover:bg-violet-50'
                                        }`}
                                    title="Change Password"
                                >
                                    <KeyRound className="w-4 h-4" />
                                </button>
                            )}
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
                    <span className={`text-[11px] font-mono ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>v3.0</span>
                    <span className={`text-[11px] ${isDark ? 'text-gray-700' : 'text-gray-300'}`}>·</span>
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
                                <label className={`text-[11px] font-semibold uppercase tracking-wider block mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Current Password</label>
                                <input
                                    type="password" value={pwCurrent} onChange={e => setPwCurrent(e.target.value)}
                                    className={`w-full rounded-lg px-3 py-2.5 text-sm border focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
                                        }`}
                                    placeholder="Enter current password"
                                />
                            </div>
                            <div>
                                <label className={`text-[11px] font-semibold uppercase tracking-wider block mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>New Password</label>
                                <input
                                    type="password" value={pwNew} onChange={e => setPwNew(e.target.value)}
                                    className={`w-full rounded-lg px-3 py-2.5 text-sm border focus:outline-none focus:ring-2 focus:ring-violet-500/50 transition-all ${isDark ? 'bg-white/[0.05] border-white/[0.08] text-white placeholder-gray-600' : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400'
                                        }`}
                                    placeholder="Enter new password (min 6 chars)"
                                />
                            </div>
                            <div>
                                <label className={`text-[11px] font-semibold uppercase tracking-wider block mb-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>Confirm New Password</label>
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
