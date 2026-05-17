import React, { useState, useEffect, useRef } from 'react';
import { Timer, ChevronDown, Pause, AlertTriangle, Check, Clock } from 'lucide-react';
import { RefreshSchedule } from '../types';

const PRESETS = [
  { label: 'Off', value: 0 },
  { label: 'Every 5 minutes', value: 5 * 60 * 1000 },
  { label: 'Every 15 minutes', value: 15 * 60 * 1000 },
  { label: 'Every 30 minutes', value: 30 * 60 * 1000 },
  { label: 'Every 1 hour', value: 60 * 60 * 1000 },
] as const;

interface RefreshSchedulerDropdownProps {
  schedule: RefreshSchedule | undefined;
  onScheduleChange: (schedule: RefreshSchedule) => void;
  isRefreshing: boolean;
}

/** Format milliseconds into MM:SS */
function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format relative time (e.g., "2m ago", "just now") */
function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

const MAX_FAILURES = 3;

export const RefreshSchedulerDropdown: React.FC<RefreshSchedulerDropdownProps> = ({
  schedule,
  onScheduleChange,
  isRefreshing,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const dropdownRef = useRef<HTMLDivElement>(null);

  const enabled = schedule?.enabled ?? false;
  const intervalMs = schedule?.intervalMs ?? 0;
  const lastRefreshAt = schedule?.lastRefreshAt;
  const failures = schedule?.consecutiveFailures ?? 0;
  const isPaused = failures >= MAX_FAILURES;

  // Derived: next refresh timestamp (not persisted)
  const nextRefreshAt = lastRefreshAt ? lastRefreshAt + intervalMs : null;
  const timeRemaining = nextRefreshAt ? nextRefreshAt - now : null;

  // Tick every second for countdown
  useEffect(() => {
    if (!enabled || !lastRefreshAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled, lastRefreshAt]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  const handleSelect = (value: number) => {
    if (value === 0) {
      onScheduleChange({ enabled: false, intervalMs: 0, lastRefreshAt: undefined, consecutiveFailures: 0 });
    } else {
      onScheduleChange({
        enabled: true,
        intervalMs: value,
        lastRefreshAt: schedule?.lastRefreshAt,
        consecutiveFailures: 0,
      });
    }
  };

  // Button appearance — matches the adjacent "Refresh Now" button styling
  const buttonLabel = enabled
    ? isPaused
      ? 'Paused'
      : isRefreshing
        ? 'Refreshing…'
        : `Auto ${PRESETS.find(p => p.value === intervalMs)?.label?.replace('Every ', '') || ''}`
    : 'Auto Refresh';

  const buttonColor = enabled
    ? isPaused
      ? 'text-amber-800 bg-amber-100 hover:bg-amber-200 border-amber-300 dark:text-amber-200 dark:bg-amber-500/20 dark:hover:bg-amber-500/30 dark:border-amber-500/30'
      : 'text-indigo-800 bg-indigo-100 hover:bg-indigo-200 border-indigo-300 dark:text-indigo-200 dark:bg-indigo-500/20 dark:hover:bg-indigo-500/30 dark:border-indigo-500/30'
    : 'text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border-indigo-200 dark:text-indigo-300 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/20 dark:border-indigo-500/25';

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${buttonColor}`}
      >
        {enabled && !isPaused && (
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
          </span>
        )}
        {isPaused && <Pause className="w-3.5 h-3.5" />}
        {!enabled && <Timer className="w-3.5 h-3.5" />}
        {buttonLabel}
        <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute top-full mt-2 right-0 w-64 bg-white dark:bg-[#1e2134] border border-slate-200 dark:border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          {/* Header */}
          <div className="px-4 py-3 border-b border-slate-100 dark:border-white/5">
            <h4 className="text-sm font-bold text-slate-800 dark:text-white flex items-center gap-2">
              <Timer className="w-4 h-4 text-indigo-500" />
              Auto Refresh
            </h4>
          </div>

          {/* Presets */}
          <div className="py-2">
            {PRESETS.map(preset => {
              const isActive = preset.value === 0
                ? !enabled
                : enabled && intervalMs === preset.value;
              return (
                <button
                  key={preset.value}
                  onClick={() => handleSelect(preset.value)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-all ${
                    isActive
                      ? 'bg-indigo-50 dark:bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 font-semibold'
                      : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all ${
                    isActive
                      ? 'border-indigo-500 bg-indigo-500'
                      : 'border-slate-300 dark:border-slate-600'
                  }`}>
                    {isActive && <Check className="w-2.5 h-2.5 text-white" strokeWidth={3} />}
                  </div>
                  {preset.label}
                </button>
              );
            })}
          </div>

          {/* Status Footer */}
          {enabled && (
            <div className="px-4 py-3 border-t border-slate-100 dark:border-white/5 space-y-2">
              {/* Failure Warning */}
              {isPaused && (
                <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 px-2.5 py-2 rounded-lg border border-amber-200 dark:border-amber-500/20">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                  <span>Paused after {failures} failures. Select an interval to retry.</span>
                </div>
              )}

              {/* Last Refreshed */}
              {lastRefreshAt && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400 font-medium">Last refreshed</span>
                  <span className="text-slate-700 dark:text-slate-200 font-semibold">
                    {formatRelativeTime(lastRefreshAt)}
                  </span>
                </div>
              )}

              {/* Countdown */}
              {!isPaused && timeRemaining !== null && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400 font-medium flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    Next refresh in
                  </span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold font-mono">
                    {timeRemaining > 0 ? formatCountdown(timeRemaining) : 'now'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
