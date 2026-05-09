/**
 * ═══════════════════════════════════════════════════════════════════
 * RECONNECT MODAL
 * ═══════════════════════════════════════════════════════════════════
 * Shown when a live database connection has expired.
 * Pre-fills host/database/username from stored metadata.
 * User only needs to re-enter their password to reconnect.
 */

import React, { useState } from 'react';

interface ReconnectModalProps {
  dbType: 'mssql' | 'pg';
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  ssl?: boolean;
  onReconnect: (password: string) => Promise<void>;
  onCancel: () => void;
  error?: string;
}

export default function ReconnectModal({
  dbType,
  host,
  port,
  database,
  username,
  ssl,
  onReconnect,
  onCancel,
  error,
}: ReconnectModalProps) {
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setIsLoading(true);
    try {
      await onReconnect(password);
    } finally {
      setIsLoading(false);
    }
  };

  const dbLabel = dbType === 'pg' ? 'PostgreSQL' : 'SQL Server';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(6px)',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'linear-gradient(145deg, #1e293b, #0f172a)',
          border: '1px solid rgba(99, 102, 241, 0.3)',
          borderRadius: '16px',
          padding: '32px',
          width: '420px',
          maxWidth: '95vw',
          boxShadow: '0 25px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(99, 102, 241, 0.1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '14px',
              background: 'linear-gradient(135deg, #f59e0b, #d97706)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 16px',
              fontSize: '28px',
            }}
          >
            🔌
          </div>
          <h2
            style={{
              color: '#f1f5f9',
              fontSize: '20px',
              fontWeight: 700,
              margin: '0 0 6px',
              fontFamily: "'Inter', sans-serif",
            }}
          >
            Connection Expired
          </h2>
          <p
            style={{
              color: '#94a3b8',
              fontSize: '13px',
              margin: 0,
              lineHeight: '1.5',
            }}
          >
            Your {dbLabel} connection has timed out.
            <br />
            Enter your password to reconnect.
          </p>
        </div>

        {/* Connection Info (read-only) */}
        <div
          style={{
            background: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(51, 65, 85, 0.5)',
            borderRadius: '10px',
            padding: '14px',
            marginBottom: '20px',
          }}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            {[
              { label: 'Host', value: host || '—' },
              { label: 'Port', value: port || (dbType === 'pg' ? '5432' : '1433') },
              { label: 'Database', value: database || '—' },
              { label: 'User', value: username || '—' },
            ].map(({ label, value }) => (
              <div key={label}>
                <div style={{ color: '#64748b', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {label}
                </div>
                <div style={{ color: '#e2e8f0', fontSize: '13px', fontWeight: 500, marginTop: '2px' }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '8px',
              padding: '10px 14px',
              marginBottom: '16px',
              color: '#fca5a5',
              fontSize: '13px',
            }}
          >
            ❌ {error}
          </div>
        )}

        {/* Password form */}
        <form onSubmit={handleSubmit}>
          <label
            style={{
              display: 'block',
              color: '#cbd5e1',
              fontSize: '13px',
              fontWeight: 600,
              marginBottom: '6px',
            }}
          >
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your database password"
            autoFocus
            required
            style={{
              width: '100%',
              padding: '10px 14px',
              borderRadius: '8px',
              border: '1px solid rgba(71, 85, 105, 0.5)',
              background: 'rgba(15, 23, 42, 0.8)',
              color: '#f1f5f9',
              fontSize: '14px',
              outline: 'none',
              boxSizing: 'border-box',
              transition: 'border-color 0.2s',
            }}
            onFocus={(e) => (e.target.style.borderColor = '#6366f1')}
            onBlur={(e) => (e.target.style.borderColor = 'rgba(71, 85, 105, 0.5)')}
          />

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
            <button
              type="button"
              onClick={onCancel}
              style={{
                flex: 1,
                padding: '10px',
                borderRadius: '8px',
                border: '1px solid rgba(71, 85, 105, 0.5)',
                background: 'transparent',
                color: '#94a3b8',
                fontSize: '14px',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(51, 65, 85, 0.3)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isLoading || !password.trim()}
              style={{
                flex: 2,
                padding: '10px',
                borderRadius: '8px',
                border: 'none',
                background: isLoading ? '#4338ca' : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                color: '#fff',
                fontSize: '14px',
                fontWeight: 600,
                cursor: isLoading ? 'wait' : 'pointer',
                opacity: !password.trim() ? 0.5 : 1,
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
              }}
            >
              {isLoading ? (
                <>
                  <span style={{ animation: 'spin 1s linear infinite', display: 'inline-block' }}>⟳</span>
                  Reconnecting...
                </>
              ) : (
                <>🔗 Reconnect</>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
