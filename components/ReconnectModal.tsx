/**
 * ═══════════════════════════════════════════════════════════════════
 * RECONNECT MODAL
 * ═══════════════════════════════════════════════════════════════════
 * Full connection form for re-establishing expired database connections.
 * Pre-fills all fields from stored metadata; user can edit any field.
 */

import React, { useState } from 'react';

interface ReconnectModalProps {
  dbType: 'mssql' | 'pg';
  host?: string;
  port?: string;
  database?: string;
  username?: string;
  ssl?: boolean;
  onReconnect: (config: {
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
    ssl: boolean;
  }) => Promise<void>;
  onCancel: () => void;
  error?: string;
}

export default function ReconnectModal({
  dbType,
  host: initialHost,
  port: initialPort,
  database: initialDatabase,
  username: initialUsername,
  ssl: initialSsl,
  onReconnect,
  onCancel,
  error,
}: ReconnectModalProps) {
  const [host, setHost] = useState(initialHost || '');
  const [port, setPort] = useState(initialPort || (dbType === 'pg' ? '5432' : '1433'));
  const [database, setDatabase] = useState(initialDatabase || '');
  const [username, setUsername] = useState(initialUsername || '');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(initialSsl ?? true);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !database.trim() || !username.trim() || !password.trim()) return;
    setIsLoading(true);
    try {
      await onReconnect({ host, port, database, username, password, ssl });
    } finally {
      setIsLoading(false);
    }
  };

  const dbLabel = dbType === 'pg' ? 'PostgreSQL' : 'SQL Server';

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '9px 12px',
    borderRadius: '8px',
    border: '1px solid rgba(71, 85, 105, 0.5)',
    background: 'rgba(15, 23, 42, 0.8)',
    color: '#f1f5f9',
    fontSize: '13px',
    outline: 'none',
    boxSizing: 'border-box' as const,
    transition: 'border-color 0.2s',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    color: '#94a3b8',
    fontSize: '12px',
    fontWeight: 600,
    marginBottom: '4px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  };

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
          padding: '28px',
          width: '440px',
          maxWidth: '95vw',
          boxShadow: '0 25px 50px rgba(0, 0, 0, 0.5), 0 0 40px rgba(99, 102, 241, 0.1)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, #f59e0b, #d97706)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              margin: '0 auto 12px',
              fontSize: '24px',
            }}
          >
            🔌
          </div>
          <h2
            style={{
              color: '#f1f5f9',
              fontSize: '18px',
              fontWeight: 700,
              margin: '0 0 4px',
              fontFamily: "'Inter', sans-serif",
            }}
          >
            Reconnect to {dbLabel}
          </h2>
          <p
            style={{
              color: '#64748b',
              fontSize: '12px',
              margin: 0,
              lineHeight: '1.5',
            }}
          >
            Your connection has expired. Enter your credentials to reconnect.
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              borderRadius: '8px',
              padding: '8px 12px',
              marginBottom: '14px',
              color: '#fca5a5',
              fontSize: '12px',
            }}
          >
            ❌ {error}
          </div>
        )}

        {/* Connection form */}
        <form onSubmit={handleSubmit}>
          {/* Host */}
          <div style={{ marginBottom: '12px' }}>
            <label style={labelStyle}>Host / Server</label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder={dbType === 'pg' ? 'your-host.railway.app' : 'your-server.database.windows.net'}
              required
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = '#6366f1')}
              onBlur={(e) => (e.target.style.borderColor = 'rgba(71, 85, 105, 0.5)')}
            />
          </div>

          {/* Port + Database row */}
          <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '10px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>Port</label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={dbType === 'pg' ? '5432' : '1433'}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#6366f1')}
                onBlur={(e) => (e.target.style.borderColor = 'rgba(71, 85, 105, 0.5)')}
              />
            </div>
            <div>
              <label style={labelStyle}>Database</label>
              <input
                type="text"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder="my_database"
                required
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#6366f1')}
                onBlur={(e) => (e.target.style.borderColor = 'rgba(71, 85, 105, 0.5)')}
              />
            </div>
          </div>

          {/* Username + Password row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                required
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#6366f1')}
                onBlur={(e) => (e.target.style.borderColor = 'rgba(71, 85, 105, 0.5)')}
              />
            </div>
            <div>
              <label style={labelStyle}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
                autoFocus
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = '#6366f1')}
                onBlur={(e) => (e.target.style.borderColor = 'rgba(71, 85, 105, 0.5)')}
              />
            </div>
          </div>

          {/* SSL toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
            <input
              type="checkbox"
              id="reconnect-ssl"
              checked={ssl}
              onChange={(e) => setSsl(e.target.checked)}
              style={{ accentColor: '#6366f1' }}
            />
            <label htmlFor="reconnect-ssl" style={{ color: '#94a3b8', fontSize: '12px', cursor: 'pointer' }}>
              Use SSL encryption
            </label>
          </div>

          {/* Buttons */}
          <div style={{ display: 'flex', gap: '10px' }}>
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
                fontSize: '13px',
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
              disabled={isLoading || !host.trim() || !database.trim() || !username.trim() || !password.trim()}
              style={{
                flex: 2,
                padding: '10px',
                borderRadius: '8px',
                border: 'none',
                background: isLoading ? '#4338ca' : 'linear-gradient(135deg, #6366f1, #4f46e5)',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 600,
                cursor: isLoading ? 'wait' : 'pointer',
                opacity: (!host.trim() || !database.trim() || !username.trim() || !password.trim()) ? 0.5 : 1,
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
                  Connecting...
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
