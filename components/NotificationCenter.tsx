import React, { useState, useRef, useEffect } from 'react';
import { Bell, Check, CheckCheck, ArrowRight, AlertTriangle, AlertCircle, Info, X } from 'lucide-react';
import { useAlertStore } from '../store/useAlertStore';
import { useTheme } from './ThemeProvider';
import { Tab } from '../types';

interface NotificationCenterProps {
  onNavigateToAlerts: () => void;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({ onNavigateToAlerts }) => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { events, unreadCount, acknowledgeEvent, acknowledgeAll } = useAlertStore();

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    };
    if (isOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  const recentEvents = events.slice(0, 20);

  const severityIcon = (s: string) => {
    if (s === 'critical') return <AlertTriangle className="w-3.5 h-3.5 text-red-400" />;
    if (s === 'warning') return <AlertCircle className="w-3.5 h-3.5 text-amber-400" />;
    return <Info className="w-3.5 h-3.5 text-blue-400" />;
  };

  const severityBorder = (s: string) => {
    if (s === 'critical') return isDark ? 'border-red-500/20' : 'border-red-200';
    if (s === 'warning') return isDark ? 'border-amber-500/20' : 'border-amber-200';
    return isDark ? 'border-blue-500/20' : 'border-blue-200';
  };

  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div className="relative" ref={ref}>
      {/* Bell Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 rounded-lg transition-all duration-200 ${isDark
          ? 'text-gray-400 hover:text-violet-400 hover:bg-violet-500/10'
          : 'text-gray-500 hover:text-violet-600 hover:bg-violet-50'
        }`}
        title="Notifications"
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center">
            <span className="absolute w-5 h-5 rounded-full bg-red-500/30 animate-ping" />
            <span className="relative w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-lg shadow-red-500/30">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div
            className={`absolute right-0 top-full mt-2 z-50 w-[380px] rounded-2xl shadow-2xl border overflow-hidden ${isDark
              ? 'bg-[#1a1f2e] border-white/[0.08]'
              : 'bg-white border-gray-200'
            }`}
          >
            {/* Header */}
            <div className={`px-4 py-3 flex items-center justify-between border-b ${isDark ? 'border-white/[0.06]' : 'border-gray-100'}`}>
              <div className="flex items-center gap-2">
                <Bell className={`w-4 h-4 ${isDark ? 'text-violet-400' : 'text-violet-600'}`} />
                <span className={`text-sm font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>Notifications</span>
                {unreadCount > 0 && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/20">
                    {unreadCount} new
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {unreadCount > 0 && (
                  <button
                    onClick={() => acknowledgeAll()}
                    className={`text-[11px] font-medium px-2 py-1 rounded-lg transition-all ${isDark
                      ? 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                      : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                    }`}
                  >
                    <CheckCheck className="w-3.5 h-3.5 inline mr-1" />
                    Mark all read
                  </button>
                )}
                <button onClick={() => setIsOpen(false)} className={`p-1 rounded-lg ${isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Events List */}
            <div className="max-h-[360px] overflow-y-auto">
              {recentEvents.length === 0 ? (
                <div className={`py-12 text-center ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  <Bell className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-medium">No alerts yet</p>
                  <p className="text-xs mt-1">Create monitoring rules to get notified</p>
                </div>
              ) : (
                <div className="p-1.5 space-y-1">
                  {recentEvents.map(evt => (
                    <div
                      key={evt.id}
                      className={`flex items-start gap-2.5 p-2.5 rounded-xl border transition-all ${
                        !evt.acknowledged
                          ? isDark ? 'bg-white/[0.03] border-white/[0.06]' : 'bg-violet-50/50 border-violet-100'
                          : isDark ? 'bg-transparent border-transparent' : 'bg-transparent border-transparent'
                      }`}
                    >
                      <div className={`mt-0.5 p-1.5 rounded-lg ${
                        evt.severity === 'critical' ? 'bg-red-500/10' :
                        evt.severity === 'warning' ? 'bg-amber-500/10' : 'bg-blue-500/10'
                      }`}>
                        {severityIcon(evt.severity)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-bold truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                            {evt.ruleName}
                          </span>
                          {!evt.acknowledged && (
                            <span className="w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
                          )}
                        </div>
                        <p className={`text-[11px] mt-0.5 leading-relaxed ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                          {evt.message}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className={`text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                            {timeAgo(evt.triggeredAt)}
                          </span>
                          {!evt.acknowledged && (
                            <button
                              onClick={() => acknowledgeEvent(evt.id)}
                              className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition-all ${isDark
                                ? 'text-violet-400 hover:bg-violet-500/10'
                                : 'text-violet-600 hover:bg-violet-50'
                              }`}
                            >
                              <Check className="w-3 h-3 inline mr-0.5" />Dismiss
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className={`px-4 py-2.5 border-t ${isDark ? 'border-white/[0.06]' : 'border-gray-100'}`}>
              <button
                onClick={() => { setIsOpen(false); onNavigateToAlerts(); }}
                className={`w-full flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-semibold transition-all ${isDark
                  ? 'text-violet-400 hover:bg-violet-500/10'
                  : 'text-violet-600 hover:bg-violet-50'
                }`}
              >
                View all rules
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
