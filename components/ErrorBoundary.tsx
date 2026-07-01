import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
    children: React.ReactNode;
    /** Compact mode for dashboard cards — shows minimal fallback */
    compact?: boolean;
    /** Custom fallback label, e.g. "Chart" or "Dashboard Card" */
    label?: string;
}

interface ErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

/**
 * Reusable Error Boundary that catches React rendering crashes.
 * Prevents one broken component from taking down the entire app.
 *
 * Usage:
 *   <ErrorBoundary label="Chart">
 *     <ChartVisualization ... />
 *   </ErrorBoundary>
 *
 *   <ErrorBoundary compact label="Dashboard Card">
 *     <DashboardCard ... />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error(`[ErrorBoundary${this.props.label ? ` — ${this.props.label}` : ''}]`, error, errorInfo);
    }

    handleRetry = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (!this.state.hasError) {
            return this.props.children;
        }

        const { compact, label } = this.props;
        const errorMessage = this.state.error?.message || 'An unexpected error occurred';

        // Compact mode — for dashboard cards and small panels
        if (compact) {
            return (
                <div className="flex flex-col items-center justify-center h-full min-h-[120px] bg-slate-800/50 rounded-xl border border-red-500/20 p-4 text-center">
                    <AlertTriangle className="w-6 h-6 text-red-400/70 mb-2" />
                    <p className="text-xs text-slate-400 mb-1">{label || 'Component'} failed to render</p>
                    <p className="text-[10px] text-slate-500 mb-3 max-w-[200px] truncate">{errorMessage}</p>
                    <button
                        onClick={this.handleRetry}
                        className="flex items-center gap-1 px-2 py-1 text-[10px] bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
                    >
                        <RefreshCw className="w-3 h-3" /> Retry
                    </button>
                </div>
            );
        }

        // Full mode — for main content areas
        return (
            <div className="flex flex-col items-center justify-center min-h-[200px] bg-slate-800/30 rounded-xl border border-red-500/20 p-8 text-center">
                <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mb-4">
                    <AlertTriangle className="w-6 h-6 text-red-400" />
                </div>
                <h3 className="text-lg font-semibold text-slate-200 mb-2">
                    {label ? `${label} Error` : 'Something went wrong'}
                </h3>
                <p className="text-sm text-slate-400 mb-1 max-w-md">{errorMessage}</p>
                <p className="text-xs text-slate-500 mb-6">This component crashed. The rest of the app is unaffected.</p>
                <button
                    onClick={this.handleRetry}
                    className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg transition-colors text-sm"
                >
                    <RefreshCw className="w-4 h-4" /> Try Again
                </button>
            </div>
        );
    }
}
