import React, { useState } from 'react';
import { useAuthStore, ROLE_PERMISSIONS } from '../store/useAuthStore';
import { UserRole } from '../types';
import { UserPlus, Trash2, Shield, Edit2, X, Check, Users, Crown, Eye, Pencil, AlertCircle } from 'lucide-react';

interface UserManagementProps {
    onClose: () => void;
}

export const UserManagement: React.FC<UserManagementProps> = ({ onClose }) => {
    const { users, currentUser, addUser, removeUser, updateUserRole } = useAuthStore();
    const [showAddForm, setShowAddForm] = useState(false);
    const [newEmail, setNewEmail] = useState('');
    const [newName, setNewName] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [newRole, setNewRole] = useState<UserRole>(UserRole.VIEWER);
    const [error, setError] = useState('');
    const [editingRoleId, setEditingRoleId] = useState<string | null>(null);

    const handleAddUser = (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        if (!newEmail.trim() || !newName.trim() || !newPassword.trim()) {
            setError('All fields are required');
            return;
        }
        const result = addUser(newEmail, newName, newPassword, newRole);
        if (!result.success) {
            setError(result.error || 'Failed to add user');
        } else {
            setNewEmail('');
            setNewName('');
            setNewPassword('');
            setNewRole(UserRole.VIEWER);
            setShowAddForm(false);
        }
    };

    const handleRemove = (id: string) => {
        const result = removeUser(id);
        if (!result.success) {
            setError(result.error || 'Cannot remove user');
            setTimeout(() => setError(''), 3000);
        }
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
                    {users.map(user => (
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
                                                        updateUserRole(user.id, role);
                                                        setEditingRoleId(null);
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

                                            {/* Edit/Delete Buttons (not for self) */}
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
                                    className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg transition-all flex items-center gap-2"
                                >
                                    <Check className="w-4 h-4" />
                                    Add User
                                </button>
                            </div>
                        </form>
                    </div>
                ) : (
                    <div className="border-t border-white/5 p-4 shrink-0">
                        <button
                            onClick={() => setShowAddForm(true)}
                            className="w-full py-3 border-2 border-dashed border-white/10 hover:border-indigo-500/30 rounded-xl text-slate-400 hover:text-indigo-400 text-sm font-bold transition-all flex items-center justify-center gap-2"
                        >
                            <UserPlus className="w-4 h-4" />
                            Add New User
                        </button>
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
