import React, { useState } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { UserRole } from '../types';
import { Eye, EyeOff, LogIn, Sparkles, AlertCircle, UserPlus, Users } from 'lucide-react';

const API_BASE = 'http://localhost:5002';

export const LoginPage: React.FC = () => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [mode, setMode] = useState<'login' | 'register'>('login');
    const loginAsGuest = useAuthStore(s => s.loginAsGuest);

    /** Map backend role strings to UserRole enum */
    const mapRole = (role: string): UserRole => {
        switch (role) {
            case 'admin': return UserRole.ADMIN;
            case 'contributor': return UserRole.CONTRIBUTOR;
            default: return UserRole.VIEWER;
        }
    };

    const AVATAR_COLORS = [
        '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
        '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
    ];

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);

        try {
            const endpoint = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
            const body = mode === 'login'
                ? { email: email.trim(), password }
                : { email: email.trim(), name: name.trim(), password, role: 'contributor' };

            const res = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok || !data.success) {
                setError(data.error || (mode === 'login' ? 'Login failed' : 'Registration failed'));
                setIsLoading(false);
                return;
            }

            // Persist JWT token
            if (data.token) {
                localStorage.setItem('qi_token', data.token);
            }

            // Sync user into Zustand auth store so the rest of the app works
            const backendUser = data.user;
            const storeUser = {
                id: backendUser.id,
                email: backendUser.email,
                name: backendUser.name,
                role: mapRole(backendUser.role),
                passwordHash: '', // not needed on client
                createdAt: Date.now(),
                avatar: AVATAR_COLORS[Math.abs(backendUser.email.length) % AVATAR_COLORS.length],
            };

            // Directly set auth state in Zustand
            useAuthStore.setState((state) => ({
                currentUser: storeUser,
                isAuthenticated: true,
                users: state.users.some(u => u.email === storeUser.email)
                    ? state.users.map(u => u.email === storeUser.email ? storeUser : u)
                    : [...state.users, storeUser],
            }));
        } catch (err: any) {
            console.error('[LoginPage] Auth request failed:', err);
            setError('Could not connect to the server. Make sure the backend is running on port 5002.');
        }

        setIsLoading(false);
    };

    const handleGuestLogin = () => {
        loginAsGuest();
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-violet-50 via-white to-orange-50 flex items-center justify-center relative overflow-hidden">
            {/* Subtle background decoration */}
            <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-0 left-0 w-[600px] h-[600px] bg-violet-200/30 rounded-full blur-[120px]" />
                <div className="absolute bottom-0 right-0 w-[500px] h-[500px] bg-orange-200/20 rounded-full blur-[100px]" />
            </div>

            <div className="relative z-10 w-full max-w-sm px-6">
                {/* Logo & Brand */}
                <div className="text-center mb-4">
                    <div className="inline-flex items-center justify-center mb-3">
                        <img src="/logo.jpg" alt="QuickInsight" className="w-12 h-12 rounded-2xl object-cover shadow-lg" />
                    </div>
                    <h1 className="text-2xl font-bold text-gray-900 tracking-tight mb-0.5">
                        QuickInsight
                    </h1>
                    <p className="text-gray-500 text-xs flex items-center justify-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-amber-500" />
                        Analytics Platform
                    </p>
                </div>

                {/* Login/Register Card */}
                <div className="bg-white border border-gray-200 rounded-2xl shadow-lg overflow-hidden">
                    <div className="px-6 pt-5 pb-4">
                        <h2 className="text-base font-bold text-gray-900 mb-0.5">
                            {mode === 'login' ? 'Welcome back' : 'Create your account'}
                        </h2>
                        <p className="text-gray-500 text-xs mb-4">
                            {mode === 'login' ? 'Sign in to your workspace' : 'Get started with QuickInsight'}
                        </p>

                        <form onSubmit={handleSubmit} className="space-y-3">
                            {mode === 'register' && (
                                <div>
                                    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                        Full Name
                                    </label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                        placeholder="John Doe"
                                        required
                                        autoFocus
                                        className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all text-sm"
                                    />
                                </div>
                            )}

                            <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Email Address
                                </label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    placeholder="you@company.com"
                                    required
                                    autoFocus={mode === 'login'}
                                    className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all text-sm"
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Password
                                </label>
                                <div className="relative">
                                    <input
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        className="w-full px-3.5 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400 transition-all text-sm pr-11"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors p-0.5"
                                    >
                                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                {mode === 'register' && (
                                    <p className="text-xs text-gray-400 mt-1.5">Min 8 chars, 1 uppercase, 1 number</p>
                                )}
                            </div>

                            {error && (
                                <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-xl text-red-600 text-sm">
                                    <AlertCircle className="w-4 h-4 shrink-0" />
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={isLoading || !email.trim() || !password.trim() || (mode === 'register' && !name.trim())}
                                className="w-full py-2.5 bg-violet-600 hover:bg-violet-700 text-white font-semibold rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-md mt-2"
                            >
                                {isLoading ? (
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : mode === 'login' ? (
                                    <>
                                        <LogIn className="w-4 h-4" />
                                        Sign In
                                    </>
                                ) : (
                                    <>
                                        <UserPlus className="w-4 h-4" />
                                        Create Account
                                    </>
                                )}
                            </button>
                        </form>

                        {/* Toggle login/register */}
                        <div className="mt-4 text-center">
                            <button
                                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
                                className="text-sm text-violet-600 hover:text-violet-800 font-medium transition-colors"
                            >
                                {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign In'}
                            </button>
                        </div>
                    </div>

                    {/* Divider */}
                    <div className="px-6">
                        <div className="flex items-center gap-3">
                            <div className="flex-1 h-px bg-gray-200" />
                            <span className="text-xs text-gray-400 font-medium">or</span>
                            <div className="flex-1 h-px bg-gray-200" />
                        </div>
                    </div>

                    {/* Guest Login */}
                    <div className="px-6 py-3">
                        <button
                            onClick={handleGuestLogin}
                            className="w-full py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl transition-all flex items-center justify-center gap-2 border border-gray-200"
                        >
                            <Users className="w-4 h-4" />
                            Continue as Guest
                        </button>
                        <p className="text-xs text-gray-400 text-center mt-1.5">
                            View-only access — no account needed
                        </p>
                    </div>
                </div>

                <p className="text-center text-xs text-gray-400 mt-6">
                    QuickInsight v3.0
                </p>
            </div>
        </div>
    );
};
