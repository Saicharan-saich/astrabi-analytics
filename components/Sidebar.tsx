import React from 'react';
import { Layout, Database, Play, Search, Upload, X, BarChart2, MessageSquare, LogOut, Users, Crown, Pencil, Eye, GitMerge, Wrench, Sparkles } from 'lucide-react';
import { Tab, UserRole } from '../types';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { Tooltip } from './Tooltip';
import classNames from 'clsx';
import { useTheme } from './ThemeProvider';

interface SidebarProps {
    activeTab: Tab;
    onTabChange: (tab: Tab) => void;
    onToggle: () => void;
    onOpenUserManagement?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeTab, onTabChange, onToggle, onOpenUserManagement }) => {
    const { currentUser, logout } = useAuthStore();
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const userRole = currentUser?.role || UserRole.VIEWER;
    const perms = ROLE_PERMISSIONS[userRole];

    const dataSection = [
        { id: Tab.UPLOAD, label: 'Data Source', icon: Upload, requiresUpload: true, tooltip: 'Upload CSV/Excel files or connect to databases like SQL Server to import your data.' },
        { id: Tab.ETL, label: 'ETL Pipeline', icon: Database, requiresEditSchema: true, tooltip: 'View each automated data cleaning step — null handling, type casting, date parsing, and more.' },
        { id: Tab.SCHEMA, label: 'Schema', icon: GitMerge, requiresEditSchema: true, tooltip: 'See how columns were classified (metric, dimension, date, ID) and override types if needed.' },
        { id: Tab.DATA, label: 'Data Explorer', icon: BarChart2, tooltip: 'Browse your cleaned data in a table view with column stats and distributions.' },
    ];

    const analysisSection = [
        { id: Tab.WORKBENCH, label: 'Workbench', icon: Play, requiresCreateVisuals: true, tooltip: 'Pick from the Question Bank or build custom queries with full control over metrics, dimensions, and filters.' },
        { id: Tab.BUILDER, label: 'Question Builder', icon: Search, requiresCreateVisuals: true, tooltip: 'A simplified natural-language-style builder: "Show me [metric] by [dimension]" with intuitive dropdowns.' },
        { id: Tab.NLQ, label: 'Ask Data', icon: MessageSquare, requiresCreateVisuals: true, tooltip: 'Type questions in plain English like "revenue by month" and get instant charts.' },
        { id: Tab.AI_SQL, label: 'AI SQL', icon: Sparkles, requiresCreateVisuals: true, tooltip: 'Ask questions in natural language — AI generates and executes SQL on your dataset. Powered by Gemini.' },
        { id: Tab.CUSTOM_QUESTIONS, label: 'Custom Questions', icon: Wrench, requiresManageQuestions: true, tooltip: 'Build custom analytical questions with SQL. Admin only.' },
    ];

    const viewSection = [
        { id: Tab.DASHBOARD, label: 'Dashboard', icon: Layout, tooltip: 'View all your pinned analyses in a dashboard layout with drag-and-drop arrangement.' },
    ];

    const filterItems = (items: typeof dataSection) => items.filter(item => {
        if ((item as any).requiresUpload && !perms.canUpload) return false;
        if ((item as any).requiresEditSchema && !perms.canEditSchema) return false;
        if ((item as any).requiresCreateVisuals && !perms.canCreateVisuals) return false;
        if ((item as any).requiresManageQuestions && !perms.canManageQuestions) return false;
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

    const renderNavItem = (item: typeof dataSection[0]) => {
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
                </button>
            </Tooltip>
        );
    };

    const renderSection = (label: string, items: typeof dataSection) => {
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
            <nav className="flex-1 space-y-3 stagger-in">
                {renderSection('Data', dataSection)}
                {renderSection('Analysis', analysisSection)}
                {renderSection('Views', viewSection)}
            </nav>

            {/* User Section */}
            <div className="mt-auto pt-2 space-y-2">
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
            </div>
        </div>
    );
};
