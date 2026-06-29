import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useDashboardStore } from '../store/useDashboardStore';
import { UserRole } from '../types';
import { Eye, EyeOff, LogIn, Sparkles, AlertCircle, UserPlus, Users, Shield, BarChart2, Brain, Zap, ArrowRight } from 'lucide-react';

interface LoginPageProps {
    onShowLegal?: () => void;
}

const API_BASE = import.meta.env.VITE_API_URL?.replace(/\/api$/, '') || 'http://localhost:5002';

export const LoginPage: React.FC<LoginPageProps> = ({ onShowLegal }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [mode, setMode] = useState<'login' | 'register'>('login');
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

            if (!res.ok) {
                setError(data.error || `${mode === 'login' ? 'Login' : 'Registration'} failed`);
                setIsLoading(false);
                return;
            }

            if (data.token && data.user) {
                const initials = data.user.name.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2);
                const colorIdx = data.user.name.split('').reduce((a: number, c: string) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;

                useAuthStore.getState().login({
                    id: data.user.id,
                    email: data.user.email,
                    name: data.user.name,
                    role: mapRole(data.user.role),
                    passwordHash: '',
                    createdAt: Date.now(),
                    avatar: AVATAR_COLORS[colorIdx],
                }, data.token);

                try { useDashboardStore.getState().fetchDashboards(); } catch {}
            }
        } catch (err) {
            setError('Unable to connect to server. Please try again.');
        } finally {
            setIsLoading(false);
        }
    };

    const handleGuestLogin = () => {
        loginAsGuest();
    };

    return (
        <div className="min-h-screen bg-mesh-animated flex items-center justify-center relative overflow-hidden">
            {/* Ambient orbs */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-32 -left-32 w-[500px] h-[500px] rounded-full bg-indigo-500/[0.07] blur-[100px] animate-float-slow" />
                <div className="absolute -bottom-32 -right-32 w-[450px] h-[450px] rounded-full bg-purple-500/[0.06] blur-[100px] animate-float-delay" />
                <div className="absolute top-1/3 right-1/4 w-[300px] h-[300px] rounded-full bg-violet-500/[0.04] blur-[80px] animate-float" />
            </div>

            {/* Dot grid overlay */}
            <div className="absolute inset-0 bg-dot-grid pointer-events-none opacity-60" />

            {/* Floating geometric shapes */}
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute top-[15%] left-[10%] w-16 h-16 border border-indigo-500/10 rounded-2xl rotate-12 animate-float" />
                <div className="absolute top-[25%] right-[15%] w-10 h-10 border border-purple-500/10 rounded-xl -rotate-6 animate-float-delay" />
                <div className="absolute bottom-[20%] left-[20%] w-12 h-12 border border-violet-500/10 rounded-lg rotate-45 animate-float-slow" />
                <div className="absolute bottom-[30%] right-[10%] w-8 h-8 bg-indigo-500/[0.04] rounded-full animate-float" />
            </div>

            <div className="relative z-10 w-full max-w-sm px-6">
                {/* Logo & Brand */}
                <div className="text-center mb-6">
                    <div className="inline-flex items-center justify-center mb-4">
                        <div className="relative">
                            <div className="absolute inset-0 rounded-2xl bg-indigo-500/20 blur-xl animate-pulse-glow" />
                            <img src="/logo.jpg" alt="QuickInsight" className="relative w-14 h-14 rounded-2xl object-cover shadow-xl ring-1 ring-white/10" />
                        </div>
                    </div>
                    <h1 className="text-3xl font-extrabold tracking-tight mb-1">
                        <span className="gradient-text">QuickInsight</span>
                    </h1>
                    {/* Rotating tagline */}
                    <div className="h-5 flex items-center justify-center overflow-hidden">
                        <p key={taglineIdx} className="text-sm text-gray-400 flex items-center gap-1.5 animate-fadeIn">
                            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                            {taglines[taglineIdx]}
                        </p>
                    </div>
                </div>

                {/* Login/Register Card */}
                <div className="glass-frost rounded-2xl overflow-hidden border-gradient glow-indigo">
                    <div className="px-6 pt-6 pb-5">
                        <h2 className="text-base font-bold text-white mb-0.5">
                            {mode === 'login' ? 'Welcome back' : 'Create your account'}
                        </h2>
                        <p className="text-gray-400 text-xs mb-5">
                            {mode === 'login' ? 'Sign in to your workspace' : 'Get started with QuickInsight'}
                        </p>

                        <form onSubmit={handleSubmit} className="space-y-3.5">
                            {mode === 'register' && (
                                <div>
                                    <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                        Full Name
                                    </label>
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={e => setName(e.target.value)}
                                        placeholder="John Doe"
                                        required
                                        autoFocus
                                        className="w-full px-4 py-2.5 glass-input rounded-xl text-sm placeholder:text-gray-500 focus-premium"
                                    />
                                </div>
                            )}

                            <div>
                                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Email Address
                                </label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={e => setEmail(e.target.value)}
                                    placeholder="you@company.com"
                                    required
                                    autoFocus={mode === 'login'}
                                    className="w-full px-4 py-2.5 glass-input rounded-xl text-sm placeholder:text-gray-500 focus-premium"
                                />
                            </div>

                            <div>
                                <label className="block text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                                    Password
                                </label>
                                <div className="relative">
                                    <input
                                        type={showPassword ? 'text' : 'password'}
                                        value={password}
                                        onChange={e => setPassword(e.target.value)}
                                        placeholder="••••••••"
                                        required
                                        className="w-full px-4 py-2.5 glass-input rounded-xl text-sm placeholder:text-gray-500 pr-10 focus-premium"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowPassword(!showPassword)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-indigo-400 transition-colors"
                                    >
                                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>

                            {error && (
                                <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
                                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={isLoading}
                                className="w-full py-3 bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600 hover:from-indigo-500 hover:via-violet-500 hover:to-purple-500 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/25 disabled:opacity-50 btn-shimmer btn-premium text-sm"
                            >
                                {isLoading ? (
                                    <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <>
                                        {mode === 'login' ? <LogIn className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
                                        {mode === 'login' ? 'Sign In' : 'Create Account'}
                                        <ArrowRight className="w-3.5 h-3.5 ml-1" />
                                    </>
                                )}
                            </button>
                        </form>

                        {/* Toggle login/register */}
                        <div className="mt-4 text-center">
                            <button
                                onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
                                className="text-sm text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
                            >
                                {mode === 'login' ? "Don't have an account? Register" : 'Already have an account? Sign In'}
                            </button>
                        </div>
                    </div>

                    {/* Divider */}
                    <div className="px-6">
                        <div className="flex items-center gap-3">
                            <div className="flex-1 h-px bg-white/[0.06]" />
                            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider">or</span>
                            <div className="flex-1 h-px bg-white/[0.06]" />
                        </div>
                    </div>

                    {/* Guest Login */}
                    <div className="px-6 py-4">
                        <button
                            onClick={handleGuestLogin}
                            className="w-full py-2.5 glass-input hover:border-indigo-500/30 font-semibold rounded-xl transition-all flex items-center justify-center gap-2 text-sm text-gray-300 hover:text-white"
                        >
                            <Users className="w-4 h-4" />
                            Continue as Guest
                        </button>
                        <p className="text-[10px] text-gray-500 text-center mt-2">
                            View-only access — no account needed
                        </p>
                    </div>
                </div>

                {/* Feature highlights */}
                <div className="flex items-center justify-center gap-6 mt-6">
                    {[
                        { icon: <BarChart2 className="w-3.5 h-3.5" />, label: '20+ Charts' },
                        { icon: <Brain className="w-3.5 h-3.5" />, label: 'AI Powered' },
                        { icon: <Zap className="w-3.5 h-3.5" />, label: 'Real-time' },
                    ].map((feat, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px] text-gray-500">
                            <span className="text-indigo-400">{feat.icon}</span>
                            {feat.label}
                        </div>
                    ))}
                </div>

                {/* Footer */}
                <div className="mt-5 text-center space-y-2">
                    <p className="text-[10px] text-gray-600 font-mono">
                        QuickInsight v3.0
                    </p>
                    {onShowLegal && (
                        <button onClick={onShowLegal} className="text-[11px] text-gray-500 hover:text-indigo-400 transition-colors flex items-center gap-1 mx-auto">
                            <Shield className="w-3 h-3" /> Privacy & Terms
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
