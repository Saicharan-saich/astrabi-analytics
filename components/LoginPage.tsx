import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useDashboardStore } from '../store/useDashboardStore';
import { UserRole } from '../types';
import { PreLoginTour } from './PreLoginTour';
import { PricingDialog } from './PricingDialog';
import { Eye, EyeOff, LogIn, AlertCircle, UserPlus, Users, Shield, BarChart2, Brain, Zap, Mail, KeyRound, Check, Tag } from 'lucide-react';

interface LoginPageProps {
    onShowLegal?: () => void;
}

const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/api$/, '') || 'http://localhost:5002';

export const LoginPage: React.FC<LoginPageProps> = ({ onShowLegal }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    // A reset link from the email opens straight on "choose a new password".
    const resetToken = (() => { try { return new URLSearchParams(window.location.search).get('reset') || ''; } catch { return ''; } })();
    const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login');
    const [notice, setNotice] = useState('');
    const [showPricing, setShowPricing] = useState(false);
    const [showTour, setShowTour] = useState(!resetToken);
    const loginAsGuest = useAuthStore(s => s.loginAsGuest);

    // Typing effect for tagline
    const [taglineIdx, setTaglineIdx] = useState(0);
    const taglines = ['Analyze Data Instantly', 'AI-Powered Insights', 'Build Stunning Dashboards', 'Ask Questions in English'];
    useEffect(() => {
        const timer = setInterval(() => setTaglineIdx(i => (i + 1) % taglines.length), 3500);
        return () => clearInterval(timer);
    }, []);

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

        setNotice('');
        try {
            if (mode === 'forgot') {
                const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim() }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) setError(data.error || 'Could not start the reset. Please try again.');
                else setNotice(data.message || 'If that email has an account, a reset link is on its way.');
                setIsLoading(false);
                return;
            }
            if (mode === 'reset' && password !== confirmPassword) {
                setError('The two passwords do not match');
                setIsLoading(false);
                return;
            }
            const endpoint = mode === 'login' ? '/api/auth/login' : mode === 'reset' ? '/api/auth/reset-password' : '/api/auth/register';
            const body = mode === 'login'
                ? { email: email.trim(), password }
                : mode === 'reset'
                    ? { token: resetToken, password }
                    : { email: email.trim(), name: name.trim(), password, role: 'contributor' };

            const res = await fetch(`${API_BASE}${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });

            const data = await res.json();

            if (!res.ok || !data.success) {
                setError(data.error || (mode === 'login' ? 'Login failed' : mode === 'reset' ? 'Could not reset the password' : 'Registration failed'));
                setIsLoading(false);
                return;
            }
            // The reset link is used up: take it out of the address bar.
            if (mode === 'reset') { try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ } }

            // Restore this account's local chart cache before cloud definitions
            // are merged. Never upload the previous account's shared workspace.
            const { saveUserAppData, restoreUserAppData, clearSharedAppData } = await import('../store/useAuthStore');
            const { resetUserData, useAppStore } = await import('../store/useAppStore');
            const previousUser = useAuthStore.getState().currentUser;
            if (previousUser) saveUserAppData(previousUser.id);
            resetUserData();
            clearSharedAppData();
            restoreUserAppData(data.user.id);
            await useAppStore.persist.rehydrate();

            // Persist JWT token only after cancelling the previous session's work.
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

            // Cloud Sync: pull saved dashboards from PostgreSQL (await to restore before UI loads)
            try {
                const { syncDashboardsFromCloud } = await import('../store/useAppStore');
                await syncDashboardsFromCloud();
                console.log('[LoginPage] ✅ Dashboard sync complete');
            } catch (syncErr) {
                console.error('[LoginPage] ❌ Dashboard sync failed:', syncErr);
            }
        } catch (err: any) {
            console.error('[LoginPage] Auth request failed:', err);
            setError('Could not reach QuickInsight. Check your internet connection and try again.');
        }

        setIsLoading(false);
    };

    const handleGuestLogin = () => {
        loginAsGuest();
    };

    if (showTour) {
        return <PreLoginTour onComplete={() => setShowTour(false)} />;
    }

    return (
        <div className="qi-auth min-h-screen flex items-center justify-center relative overflow-y-auto py-10">
            <div className="relative z-10 w-full max-w-sm px-6">
                {/* Logo & Brand */}
                <div className="text-center mb-4">
                    <div className="inline-flex items-center justify-center mb-3">
                        <img src="/logo.jpg" alt="QuickInsight" className="w-11 h-11 rounded-xl object-cover qi-auth-logo" />
                    </div>
                    <h1 className="qi-auth-title text-[22px] font-semibold tracking-tight mb-0.5">QuickInsight</h1>
                    {/* Rotating tagline */}
                    <div className="h-5 flex items-center justify-center overflow-hidden">
                        <p key={taglineIdx} className="qi-auth-muted text-xs flex items-center gap-1.5 animate-fadeIn">
                            {taglines[taglineIdx]}
                        </p>
                    </div>
                </div>

                {/* Login/Register Card */}
                <div className="qi-auth-card overflow-hidden">
                    <div className="px-7 pt-7 pb-5">
                        <h2 className="qi-auth-title text-base font-semibold mb-0.5">
                            {mode === 'login' ? 'Welcome back' : mode === 'forgot' ? 'Reset your password' : mode === 'reset' ? 'Choose a new password' : 'Create your account'}
                        </h2>
                        <p className="qi-auth-muted text-[13px] mb-5">
                            {mode === 'login' ? 'Sign in to your workspace'
                                : mode === 'forgot' ? 'Enter your email and we\u2019ll send you a link to choose a new one.'
                                    : mode === 'reset' ? 'At least 8 characters. You\u2019ll be signed in straight away.'
                                        : 'Get started with QuickInsight'}
                        </p>

                        <form onSubmit={handleSubmit} className="space-y-3">
                            {mode === 'register' && (
                                <div>
                                    <label htmlFor="quickinsight-name" className="qi-auth-label block text-[13px] font-medium mb-1.5">
                                        Full Name
                                    </label>
                                    <input
                                        id="quickinsight-name"
                                        name="name"
                                        autoComplete="name"
                                        type="text"
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                        placeholder="John Doe"
                                        required
                                        autoFocus
                                        className="qi-auth-input w-full px-3.5 py-2.5 text-sm"
                                    />
                                </div>
                            )}

                            {mode !== 'reset' && <div>
                                <label htmlFor="quickinsight-email" className="qi-auth-label block text-[13px] font-medium mb-1.5">
                                    Email Address
                                </label>
                                <input
                                    id="quickinsight-email"
                                    name="email"
                                    autoComplete="email"
                                    type="email"
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    placeholder="you@company.com"
                                    required
                                    autoFocus={mode === 'login' || mode === 'forgot'}
                                    className="qi-auth-input w-full px-3.5 py-2.5 text-sm"
                                />
                            </div>}

                            {mode !== 'forgot' && <div>
                                <div className="flex items-center justify-between mb-1.5">
                                    <label htmlFor="quickinsight-password" className="qi-auth-label block text-[13px] font-medium">
                                        {mode === 'reset' ? 'New password' : 'Password'}
                                    </label>
                                    {mode === 'login' && (
                                        <button type="button" onClick={() => { setMode('forgot'); setError(''); setNotice(''); }} className="qi-auth-link text-[12px] font-medium">
                                            Forgot password?
                                        </button>
                                    )}
                                </div>
                                <div className="relative">
                                    <input
                                        id="quickinsight-password"
                                        name="password"
                                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                        autoFocus={mode === 'reset'}
                                        minLength={mode === 'login' ? undefined : 8}
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        className="qi-auth-input w-full px-3.5 py-2.5 text-sm pr-10"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                                        aria-pressed={showPassword}
                                        className="qi-auth-muted absolute right-3 top-1/2 -translate-y-1/2 hover:text-[var(--color-primary)] transition-colors"
                                    >
                                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>}

                            {mode === 'reset' && (
                                <div>
                                    <label htmlFor="quickinsight-password-confirm" className="qi-auth-label block text-[13px] font-medium mb-1.5">Type it again</label>
                                    <input id="quickinsight-password-confirm" name="password-confirm" autoComplete="new-password" type={showPassword ? 'text' : 'password'}
                                        value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="••••••••" required minLength={8}
                                        className="qi-auth-input w-full px-3.5 py-2.5 text-sm" />
                                </div>
                            )}

                            {notice && (
                                <div role="status" className="qi-auth-notice flex items-start gap-2 p-3 rounded-lg text-xs">
                                    <Check className="w-3.5 h-3.5 shrink-0 mt-px" />
                                    {notice}
                                </div>
                            )}

                            {error && (
                                <div role="alert" aria-live="assertive" className="qi-auth-error flex items-center gap-2 p-3 rounded-lg text-xs">
                                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={isLoading}
                                className="qi-auth-primary w-full py-2.5 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50 text-sm"
                            >
                                {isLoading ? (
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <>
                                        {mode === 'login' ? <LogIn className="w-4 h-4" /> : mode === 'forgot' ? <Mail className="w-4 h-4" /> : mode === 'reset' ? <KeyRound className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
                                        {mode === 'login' ? 'Sign In' : mode === 'forgot' ? 'Send reset link' : mode === 'reset' ? 'Save and sign in' : 'Create Account'}
                                    </>
                                )}
                            </button>
                        </form>

                        {/* Toggle login/register */}
                        <div className="mt-3 text-center">
                            <button
                                onClick={() => {
                                    if (mode === 'reset') { try { window.history.replaceState({}, '', window.location.pathname); } catch { /* ignore */ } }
                                    setMode(mode === 'login' ? 'register' : 'login'); setError(''); setNotice('');
                                }}
                                className="qi-auth-link text-[13px] font-medium transition-colors"
                            >
                                {mode === 'login' ? "Don't have an account? Register" : mode === 'register' ? 'Already have an account? Sign In' : 'Back to sign in'}
                            </button>
                        </div>
                    </div>

                    {/* Divider */}
                    <div className="px-7">
                        <div className="flex items-center gap-3">
                            <div className="qi-auth-rule flex-1 h-px" />
                            <span className="qi-auth-muted text-[11px] font-medium uppercase tracking-wider">or</span>
                            <div className="qi-auth-rule flex-1 h-px" />
                        </div>
                    </div>

                    {/* Guest Login */}
                    <div className="px-7 pt-4 pb-6">
                        <button
                            onClick={handleGuestLogin}
                            className="qi-auth-secondary w-full py-2.5 font-medium rounded-lg transition-colors flex items-center justify-center gap-2 text-sm"
                        >
                            <Users className="w-4 h-4" />
                            Continue as Guest
                        </button>
                        <p className="qi-auth-muted text-xs text-center mt-2 leading-relaxed">
                            Try it with your own file or sample data, no account needed. Asking the AI needs a free account.
                        </p>
                    </div>
                </div>

                {/* Feature highlights */}
                <div className="flex items-center justify-center gap-5 mt-5">
                    {[
                        { icon: <BarChart2 className="w-3 h-3" />, label: '20+ Charts' },
                        { icon: <Brain className="w-3 h-3" />, label: 'AI Powered' },
                        { icon: <Zap className="w-3 h-3" />, label: 'Real-time' },
                    ].map((feat, i) => (
                        <div key={i} className="qi-auth-muted flex items-center gap-1 text-xs">
                            <span className="text-[var(--color-primary)]">{feat.icon}</span>
                            {feat.label}
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div className="mt-3 text-center">
                    <span className="qi-auth-muted text-[11px] font-mono">v3.0</span>
                    <span className="qi-auth-muted text-[11px] mx-1.5">·</span>
                    <button type="button" onClick={() => setShowPricing(true)} className="qi-auth-muted text-[11px] hover:text-[var(--color-primary)] transition-colors inline-flex items-center gap-1">
                        <Tag className="w-2.5 h-2.5" /> Plans & prices
                    </button>
                    {onShowLegal && (
                        <>
                            <span className="qi-auth-muted text-[11px] mx-1.5">·</span>
                            <button onClick={onShowLegal} className="qi-auth-muted text-[11px] hover:text-[var(--color-primary)] transition-colors inline-flex items-center gap-1">
                                <Shield className="w-2.5 h-2.5" /> Privacy & Terms
                            </button>
                        </>
                    )}
                </div>
            </div>
            {showPricing && (
                <PricingDialog
                    onClose={() => setShowPricing(false)}
                    onStart={() => { setShowPricing(false); setMode('register'); setError(''); setNotice(''); }}
                />
            )}
        </div>
    );
};
