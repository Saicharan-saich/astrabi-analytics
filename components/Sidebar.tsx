import React, { useState } from 'react';
import { Layout, Database, Play, Search, Upload, X, BarChart2, MessageSquare, LogOut, Users, Crown, Pencil, Eye, GitMerge, Wrench, Sparkles, KeyRound, Check, AlertTriangle, Loader2, ChevronRight, Lightbulb, Bell, Activity, Zap, Shield } from 'lucide-react';
import { Tab, UserRole } from '../types';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { useAlertStore } from '../store/useAlertStore';
import { Tooltip } from './Tooltip';
import { PageInfoButton, PageKey } from './PageInfoButton';
import classNames from 'clsx';
import { useTheme } from './ThemeProvider';

interface SidebarProps {
    activeTab: Tab;
    onTabChange: (tab: Tab) => void;
    onToggle: () => void;
    onOpenUserManagement?: () => void;
    hasVisualResult?: boolean;
    onDataStory?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, onToggle, onOpenUserManagement, hasVisualResult, onDataStory }) => {
    const { currentUser, logout } = useAuthStore();
    const { unreadCount } = useAlertStore();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const userRole = currentUser?.role || UserRole.VIEWER;
    const perms = ROLE_PERMISSIONS[userRole];

    // Change Password modal state
    const [showChangePw, setShowChangePw] = useState(false);
    const [pwCurrent, setPwCurrent] = useState('');
    const [pwNew, setPwNew] = useState('');
    const [pwConfirm, setPwConfirm] = useState('');
    const [pwError, setPwError] = useState('');
    const [pwSuccess, setPwSuccess] = useState(false);
    const [pwLoading, setPwLoading] = useState(false);

    // Explore Data collapsible state
    const exploreDataTabs = [Tab.COLUMN_MAPPING, Tab.ETL, Tab.SCHEMA, Tab.DATA, Tab.DATASET_SUMMARY];
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

    // Explore Data sub-items (collapsed under one group)
    const exploreDataItems = [
        { id: Tab.COLUMN_MAPPING, label: 'Column Mapping', icon: Eye, tooltip: 'Review and adjust AI-detected column types, semantic roles, and data formats before analysis.' },
        { id: Tab.ETL, label: 'ETL Pipeline', icon: Database, requiresEditSchema: true, tooltip: 'View each automated data cleaning step — null handling, type casting, date parsing, and more.' },
        { id: Tab.SCHEMA, label: 'Schema', icon: GitMerge, requiresEditSchema: true, tooltip: 'See how columns were classified (metric, dimension, date, ID) and override types if needed.' },
        { id: Tab.DATA, label: 'Data Explorer', icon: BarChart2, tooltip: 'Browse your cleaned data in a table view with column stats and distributions.' },
        { id: Tab.DATASET_SUMMARY, label: 'Dataset Summary', icon: BarChart2, tooltip: 'See column-level statistics, distributions, data quality, and a quick preview of your dataset.' },
    ];

    const analysisSection = [
        { id: Tab.SMART_QUESTIONS, label: 'Smart Insights', icon: Lightbulb, requiresCreateVisuals: true, tooltip: 'AI-curated questions tailored to your dataset. Click any card to instantly run the analysis.' },
        { id: Tab.BUILDER, label: 'Question Builder', icon: Search, requiresCreateVisuals: true, tooltip: 'A simplified natural-language-style builder: "Show me [metric] by [dimension]" with intuitive dropdowns.' },
        { id: Tab.AI_SQL, label: 'AI SQL', icon: Sparkles, requiresCreateVisuals: true, tooltip: 'Ask questions in natural language — AI generates and executes SQL on your dataset. Powered by Gemini.' },
        ...(hasVisualResult ? [{ id: Tab.VISUAL_PREVIEW, label: 'Visual Result', icon: BarChart2, requiresCreateVisuals: true, tooltip: 'View your latest AI SQL result — chart, table, SQL, and formatting controls.' }] : []),
        { id: Tab.DERIVED_COLUMNS, label: 'Derived Columns', icon: Lightbulb, requiresCreateVisuals: true, tooltip: 'AI-suggested and custom derived columns — create new business metrics from your data.' },
        { id: Tab.CUSTOM_QUESTIONS, label: 'Custom Questions', icon: Wrench, requiresManageQuestions: true, tooltip: 'Build custom analytical questions with SQL. Admin only.' },
    ];

    const viewSection = [
        { id: Tab.DASHBOARD, label: 'Dashboard', icon: Layout, tooltip: 'View all your pinned analyses in a dashboard layout with drag-and-drop arrangement.' },
        { id: Tab.ALERTS, label: 'Monitoring', icon: Bell, badge: unreadCount, tooltip: 'Create business rules to monitor metrics. Get alerted when thresholds are crossed or trends change.' },
        ...(userRole === UserRole.ADMIN ? [{ id: Tab.USER_INSIGHTS, label: 'User Insights', icon: Activity, requiresManageUsers: true, tooltip: 'View usage analytics per user — logins, queries, uploads, and engagement scores. Admin only.' }] : []),
    ];

    const filterItems = (items: any[]) => items.filter(item => {
        if (item.requiresUpload && !perms.canUpload) return false;
        if (item.requiresEditSchema && !perms.canEditSchema) return false;
        if (item.requiresCreateVisuals && !perms.canCreateVisuals) return false;
        if (item.requiresManageQuestions && !perms.canManageQuestions) return false;
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
                        "w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-150 group relative text-[13px] font-medium",
                        isActive
                            ? isDark
                                ? "bg-violet-500/15 text-violet-300"
                                : "bg-violet-50 text-violet-700"
                            : isDark
                                ? "text-gray-400 hover:bg-white/[0.05] hover:text-gray-200"
                                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                    )}
                >
                    {/* Active left accent bar */}
                    {isActive && (
                        <div className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full ${isDark ? 'bg-violet-400' : 'bg-violet-600'
                            }`} />
                    )}

                    <item.icon className={classNames(
                        "w-[17px] h-[17px] transition-colors duration-150",
                        isActive
                            ? isDark ? "text-violet-400" : "text-violet-600"
                            : isDark ? "text-gray-500" : "text-gray-400"
                    )} />
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
                <div className="px-3 mb-1.5">
                    <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${isDark ? 'text-gray-500' : 'text-gray-400'
                        }`}>
                        {label}
                    </span>
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
        <div className="flex flex-col h-full p-3">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 px-1">
                <div className="flex items-center gap-2.5">
                    <img src="/logo.jpg" alt="QuickInsight" className="w-8 h-8 rounded-lg object-cover shadow-sm" />
                    <div>
                        <span className={`font-bold text-[15px] tracking-tight block leading-tight ${isDark ? 'text-white' : 'text-gray-900'
                            }`}>QuickInsight</span>
                        <span className={`text-[10px] font-medium tracking-wide ${isDark ? 'text-gray-500' : 'text-gray-400'
                            }`}>Analytics Platform</span>
                    </div>
                </div>
                <button
                    onClick={onToggle}
                    className={`p-1.5 rounded-lg transition-all duration-150 ${isDark ? 'hover:bg-white/10 text-gray-500' : 'hover:bg-gray-100 text-gray-400'
                        }`}
                    title="Toggle Sidebar"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Divider */}
            <div className={`mx-2 mb-3 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-gray-200'}`} />

            {/* Navigation */}
            <nav className="flex-1 min-h-0 overflow-y-auto space-y-3 stagger-in">
                {/* Data section: Upload + collapsible Explore Data */}
                <div className="mb-1">
                    <div className="px-3 mb-1.5">
                        <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            Data
                        </span>
                    </div>
                    <div className="space-y-0.5">
                        {filterItems(dataSection).map(renderNavItem)}
                        {renderExploreDataGroup()}
                    </div>
                </div>
                {renderSection('Analysis', analysisSection)}
                {/* Data Story special button */}
                {onDataStory && perms.canCreateVisuals && (
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
            <div className="shrink-0 mt-auto pt-2 space-y-2">
                <div className={`mx-2 mb-2 h-px ${isDark ? 'bg-white/[0.06]' : 'bg-gray-200'}`} />

                {perms.canManageUsers && onOpenUserManagement && (
                    <button
                        onClick={onOpenUserManagement}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-[13px] font-medium ${isDark ? 'text-gray-400 hover:bg-white/[0.05] hover:text-gray-200' : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                            }`}
                    >
                        <Users className={`w-[17px] h-[17px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
                        <span>Manage Users</span>
                    </button>
                )}

                {currentUser && (
                    <div className={`rounded-lg p-2.5 border transition-all ${isDark ? 'bg-white/[0.03] border-white/[0.06] hover:bg-white/[0.05]' : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
                        }`}>
                        <div className="flex items-center gap-2.5">
                            <div
                                className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-xs shadow-sm shrink-0"
                                style={{ backgroundColor: currentUser.avatar || '#7c3aed' }}
                            >
                                {currentUser.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>{currentUser.name}</div>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${getRoleBadgeClasses(currentUser.role)}`}>
                                        {getRoleIcon(currentUser.role)}
                                        {ROLE_PERMISSIONS[currentUser.role].label}
                                    </span>
                                </div>
                            </div>
                            <button
                                onClick={() => { setShowChangePw(true); setPwError(''); setPwSuccess(false); setPwCurrent(''); setPwNew(''); setPwConfirm(''); }}
                                className={`p-1.5 rounded-lg transition-all duration-150 shrink-0 ${isDark ? 'text-gray-500 hover:text-violet-400 hover:bg-violet-500/10' : 'text-gray-400 hover:text-violet-500 hover:bg-violet-50'
                                    }`}
                                title="Change Password"
                            >
                                <KeyRound className="w-4 h-4" />
                            </button>
                            <button
                                onClick={logout}
                                className={`p-1.5 rounded-lg transition-all duration-150 shrink-0 ${isDark ? 'text-gray-500 hover:text-red-400 hover:bg-red-500/10' : 'text-gray-400 hover:text-red-500 hover:bg-red-50'
                                    }`}
                                title="Sign Out"
                            >
                                <LogOut className="w-4 h-4" />
                            </button>
                        </div>
                    </div>
                )}

                <div className="mt-2 px-3 py-1.5 text-center">
                    <span className={`text-[10px] font-mono ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>v1.0.0</span>
                    <span className={`text-[10px] mx-1 ${isDark ? 'text-gray-700' : 'text-gray-300'}`}>·</span>
                    <span className={`text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>QuickInsight</span>
                </div>
                <div className="px-3 pb-3 pt-1">
                    <button
                        onClick={() => onTabChange(Tab.LEGAL)}
                        className={`w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${isDark ? 'text-gray-400 hover:text-indigo-300 hover:bg-white/[0.05] border border-white/[0.06]' : 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50 border border-gray-200'}`}
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
