import React, { useEffect, useState } from 'react';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { UserRole } from '../types';
import { UserPlus, Trash2, Shield, Edit2, X, Check, Users, Crown, Eye, Pencil, AlertCircle, LogOut, Loader2 } from 'lucide-react';

interface UserManagementProps {
    onClose: () => void;
}

export const UserManagement: React.FC<UserManagementProps> = ({ onClose }) => {
    const { users, currentUser, removeUser } = useAuthStore();
    const [showAddForm, setShowAddForm] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [newName, setNewName] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<UserRole>(UserRole.VIEWER);
    const [error, setError] = useState('');
    const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

    const [isAdding, setIsAdding] = useState(false);
    const [isLoadingUsers, setIsLoadingUsers] = useState(true);
    const [logoutAllLoading, setLogoutAllLoading] = useState(false);
    const [logoutUserId, setLogoutUserId] = useState<string | null>(null);
    const [logoutSuccess, setLogoutSuccess] = useState('');

    const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/api$/, '') || 'http://localhost:5002';

    const AVATAR_COLORS = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
        '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
    ];

    /** Map UserRole enum to backend role string */
    const roleToBackend = (role: UserRole): string => {
        switch (role) {
            case UserRole.ADMIN: return 'admin';
            case UserRole.CONTRIBUTOR: return 'contributor';
            case UserRole.VIEWER: return 'viewer';
            default: return 'viewer';
        }
    };

    /** Map backend role string to UserRole enum */
    const mapRole = (role: string): UserRole => {
        switch (role) {
            case 'admin': return UserRole.ADMIN;
            case 'contributor': return UserRole.CONTRIBUTOR;
            default: return UserRole.VIEWER;
        }
    };

    const toStoreUser = (user: any, index: number) => ({
        id: String(user.id),
        email: user.email,
        name: user.name,
        role: mapRole(user.role),
        passwordHash: '',
        createdAt: user.created_at ? new Date(user.created_at).getTime() : Date.now(),
        avatar: AVATAR_COLORS[index % AVATAR_COLORS.length],
    });

    const loadUsers = async () => {
        setIsLoadingUsers(true);
        try {
            const token = localStorage.getItem('qi_token');
            const res = await fetch(`${API_BASE}/api/admin/users`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setError(data.error || 'Failed to load users');
                return;
            }
            useAuthStore.setState({ users: data.users.map(toStoreUser) });
        } catch (err) {
            console.error('[UserManagement] Load users failed:', err);
            setError('Could not load users from the server.');
        } finally {
            setIsLoadingUsers(false);
        }
    };

    useEffect(() => {
        void loadUsers();
    }, []);

    const handleUpdateRole = async (userId: string, role: UserRole) => {
        setError('');
        try {
            const token = localStorage.getItem('qi_token');
            const res = await fetch(`${API_BASE}/api/admin/users/${userId}/role`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ role: roleToBackend(role) }),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setError(data.error || 'Failed to update user role');
                return;
            }
            await loadUsers();
            setEditingRoleId(null);
        } catch (err) {
            console.error('[UserManagement] Update role failed:', err);
            setError('Could not update the user role.');
        }
    };

    const handleAddUser = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (!newEmail.trim() || !newName.trim() || !newPassword.trim()) {
            setError('All fields are required');
            return;
        }

        setIsAdding(true);
        try {
            const token = localStorage.getItem('qi_token');
            const res = await fetch(`${API_BASE}/api/admin/users`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({
                    email: newEmail.trim(),
                    name: newName.trim(),
                    password: newPassword,
                    role: roleToBackend(newRole),
                }),
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                setError(data.error || 'Failed to add user');
                return;
            }

            await loadUsers();
            setNewEmail('');
            setNewName('');
            setNewPassword('');
            setNewRole(UserRole.VIEWER);
            setShowAddForm(false);
        } catch (err: any) {
            console.error('[UserManagement] Add user failed:', err);
            setError('Could not connect to the server. Make sure the backend is running.');
        } finally {
            setIsAdding(false);
        }
    };

    const handleRemove = (id: string) => {
        const result = removeUser(id);
        if (!result.success) {
            setError(result.error || 'Cannot remove user');
            setTimeout(() => setError(''), 3000);
        }
    };

    const handleLogoutAllDevices = async (targetUserId?: string) => {
        if (targetUserId) setLogoutUserId(targetUserId);
        else setLogoutAllLoading(true);
        setError('');
        setLogoutSuccess('');
        try {
            const token = localStorage.getItem('qi_token');
            const res = await fetch(`${API_BASE}/api/auth/logout-all-devices`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                body: JSON.stringify(targetUserId ? { targetUserId } : {}),
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                setError(data.error || 'Failed to logout from all devices');
            } else {
                setLogoutSuccess(data.message || 'Sessions revoked successfully');
                setTimeout(() => setLogoutSuccess(''), 4000);
            }
        } catch {
            setError('Could not connect to server');
        }
        setLogoutUserId(null);
        setLogoutAllLoading(false);
    };

    const getRoleIcon = (role: UserRole) => {
        switch (role) {
            case UserRole.ADMIN: return <Crown className="w-3.5 h-3.5" />;
            case UserRole.CONTRIBUTOR: return <Pencil className="w-3.5 h-3.5" />;
            case UserRole.VIEWER: return <Eye className="w-3.5 h-3.5" />;
        }
    };

    const getRoleBadgeClasses = (role: UserRole) => {
        switch (role) {
            case UserRole.ADMIN: return 'bg-rose-500/15 text-rose-400 ring-rose-500/30';
            case UserRole.CONTRIBUTOR: return 'bg-violet-500/15 text-violet-400 ring-violet-500/30';
            case UserRole.VIEWER: return 'bg-cyan-500/15 text-cyan-400 ring-cyan-500/30';
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col">
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-white/5 shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                            <Users className="w-5 h-5 text-white" />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-white">User Management</h2>
                            <p className="text-slate-400 text-xs">{users.length} user{users.length !== 1 ? 's' : ''} registered</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-2 text-slate-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="mx-6 mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm flex items-center gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        {error}
                    </div>
                )}

                {/* User List */}
                <div className="flex-1 overflow-y-auto p-6 space-y-3">
                    {isLoadingUsers ? (
                        <div className="py-10 text-center text-sm text-slate-400 flex items-center justify-center gap-2">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Loading users from the workspace…
                        </div>
                    ) : users.map(user => (
                        <div
                            key={user.id}
                            className={`group p-4 rounded-xl border transition-all ${user.id === currentUser?.id
                                    ? 'bg-indigo-500/5 border-indigo-500/20'
                                    : 'bg-slate-800/50 border-white/5 hover:border-white/10'
                                }`}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    {/* Avatar */}
                                    <div
                                        className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shadow-lg"
                                        style={{ backgroundColor: user.avatar || '#6366f1' }}
                                    >
                                        {user.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-white font-semibold text-sm">{user.name}</span>
                                            {user.id === currentUser?.id && (
                                                <span className="text-[10px] font-bold px-1.5 py-0.5 bg-emerald-500/15 text-emerald-400 rounded">YOU</span>
                                            )}
                                        </div>
                                        <span className="text-slate-400 text-xs">{user.email}</span>
                                    </div>
                                </div>

                                <div className="flex items-center gap-2">
                                    {/* Role Badge / Selector */}
                                    {editingRoleId === user.id ? (
                                        <div className="flex items-center gap-1">
                                            {Object.values(UserRole).map(role => (
                                                <button
                                                    key={role}
                                                    onClick={() => {
                                                        void handleUpdateRole(user.id, role);
                                                    }}
                                                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ring-1 ${user.role === role
                                                            ? getRoleBadgeClasses(role)
                                                            : 'text-slate-400 ring-white/10 hover:ring-white/20'
                                                        }`}
                                                >
                                                    {ROLE_PERMISSIONS[role].label}
                                                </button>
                                            ))}
                                            <button
                                                onClick={() => setEditingRoleId(null)}
                                                className="p-1 text-slate-400 hover:text-white"
                                            >
                                                <X className="w-3.5 h-3.5" />
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold ring-1 ${getRoleBadgeClasses(user.role)}`}>
                                                {getRoleIcon(user.role)}
                                                {ROLE_PERMISSIONS[user.role].label}
                                            </span>

                                            {/* Edit/Delete/Revoke Buttons (not for self) */}
                                            {user.id !== currentUser?.id && (
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={() => setEditingRoleId(user.id)}
                                                        className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-indigo-500/10 rounded-lg transition-colors"
                                                        title="Change Role"
                                                    >
                                                        <Edit2 className="w-3.5 h-3.5" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleLogoutAllDevices(user.id)}
                                                        disabled={logoutUserId === user.id}
                                                        className="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg transition-colors disabled:opacity-50"
                                                        title="Revoke All Sessions"
                                                    >
                                                        {logoutUserId === user.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
                                                    </button>
                                                    <button
                                                        onClick={() => handleRemove(user.id)}
                                                        className="p-1.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                                        title="Remove User"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Meta line */}
                            <div className="mt-2 text-[11px] text-slate-500">
                                {ROLE_PERMISSIONS[user.role].description} · Joined {new Date(user.createdAt).toLocaleDateString()}
                            </div>
                        </div>
                    ))}
                    )}
                </div>

                {/* Add User Form */}
                {showAddForm ? (
                    <div className="border-t border-white/5 p-6 bg-slate-800/50 shrink-0">
                        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2">
                            <UserPlus className="w-4 h-4 text-indigo-400" />
                            Add New User
                        </h3>
                        <form onSubmit={handleAddUser} className="space-y-3">
                            <div className="grid grid-cols-2 gap-3">
                                <input
                                    type="text"
                                    value={newName}
                                    onChange={e => setNewName(e.target.value)}
                                    placeholder="Full Name"
                                    required
                                    className="px-3 py-2.5 bg-slate-900 border border-white/10 rounded-lg text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                />
                                <input
                                    type="email"
                                    value={newEmail}
                                    onChange={e => setNewEmail(e.target.value)}
                                    placeholder="Email Address"
                                    required
                                    className="px-3 py-2.5 bg-slate-900 border border-white/10 rounded-lg text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <input
                                    type="password"
                                    value={newPassword}
                                    onChange={e => setNewPassword(e.target.value)}
                                    placeholder="Password"
                                    required
                                    className="px-3 py-2.5 bg-slate-900 border border-white/10 rounded-lg text-white placeholder:text-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                />
                                <select
                                    value={newRole}
                                    onChange={e => setNewRole(e.target.value as UserRole)}
                                    className="px-3 py-2.5 bg-slate-900 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                >
                                    {Object.values(UserRole).map(role => (
                                        <option key={role} value={role}>
                                            {ROLE_PERMISSIONS[role].label} — {ROLE_PERMISSIONS[role].description}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex justify-end gap-2 pt-1">
                                <button
                                    type="button"
                                    onClick={() => { setShowAddForm(false); setError(''); }}
                                    className="px-4 py-2 text-slate-400 hover:text-white text-sm font-medium transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={isAdding}
                                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {isAdding ? (
                                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    ) : (
                                        <Check className="w-4 h-4" />
                                    )}
                                    {isAdding ? 'Adding...' : 'Add User'}
                                </button>
                            </div>
                        </form>
                    </div>
                ) : (
                    <div className="border-t border-white/5 p-4 shrink-0 space-y-3">
                        {logoutSuccess && (
                            <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-300 text-xs flex items-center gap-2">
                                <Check className="w-3.5 h-3.5" /> {logoutSuccess}
                            </div>
                        )}
                        <div className="flex gap-2">
                            <button
                                onClick={() => setShowAddForm(true)}
                                className="flex-1 py-3 border-2 border-dashed border-white/10 hover:border-indigo-500/30 rounded-xl text-slate-400 hover:text-indigo-400 text-sm font-bold transition-all flex items-center justify-center gap-2"
                            >
                                <UserPlus className="w-4 h-4" />
                                Add New User
                            </button>
                            <button
                                onClick={() => handleLogoutAllDevices()}
                                disabled={logoutAllLoading}
                                className="py-3 px-5 border-2 border-dashed border-red-500/20 hover:border-red-500/40 rounded-xl text-red-400 hover:text-red-300 text-sm font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                title="Invalidate all active sessions for all users"
                            >
                                {logoutAllLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
                                Logout All Devices
                            </button>
                        </div>
                    </div>
                )}

                {/* Role Legend */}
                <div className="border-t border-white/5 px-6 py-3 bg-slate-950/50 shrink-0">
                    <div className="flex items-center gap-6 text-[11px] text-slate-500">
                        {Object.entries(ROLE_PERMISSIONS).map(([role, perm]) => (
                            <span key={role} className="flex items-center gap-1.5">
                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: perm.color }} />
                                <span className="font-bold">{perm.label}</span>: {perm.description}
                            </span>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};
