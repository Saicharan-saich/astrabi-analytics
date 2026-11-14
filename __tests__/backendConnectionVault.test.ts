/**
 * Database passwords for reconnecting stay on the server; the browser holds a
 * ticket that only works for its own account, for a few hours.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { createConnectionVault } = require('../backend/connectionVault.js');

const config = { host: 'db.shop.co.uk', port: 5432, database: 'sales', username: 'reader', ssl: true, useWindowsAuth: false };

describe('reconnect tickets', () => {
    it('give the saved connection back to the account that made it, and to nobody else', () => {
        const vault = createConnectionVault();
        const ticket = vault.store('u1', 'pg', config, 's3cret password');
        expect(ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(ticket).not.toContain('s3cret');
        expect(vault.open('u1', ticket)).toEqual({ kind: 'pg', config, password: 's3cret password' });
        expect(vault.open('u2', ticket)).toBeNull();
        expect(vault.open('u1', `${ticket}x`)).toBeNull();
        expect(vault.open('u1', '')).toBeNull();
    });

    it('expire, and are forgotten one at a time or all together', () => {
        let now = 1_000;
        const vault = createConnectionVault({ ttlMs: 60_000, now: () => now });
        const a = vault.store('u1', 'mssql', config, 'a');
        const b = vault.store('u1', 'pg', config, 'b');
        const other = vault.store('u2', 'pg', config, 'c');
        vault.forget('u2', a); // someone else's ticket: no effect
        expect(vault.open('u1', a)).not.toBeNull();
        vault.forget('u1', a);
        expect(vault.open('u1', a)).toBeNull();
        expect(vault.open('u1', b)).not.toBeNull();
        vault.forget('u1');
        expect(vault.open('u1', b)).toBeNull();
        expect(vault.open('u2', other)).not.toBeNull();
        now += 60_001;
        expect(vault.open('u2', other)).toBeNull();
        expect(vault.size()).toBe(0);
    });

    it('the website never writes a database password to browser storage', () => {
        const app = readFileSync(join(process.cwd(), 'App.tsx'), 'utf8');
        const panel = readFileSync(join(process.cwd(), 'components', 'ConnectorsPanel.tsx'), 'utf8');
        expect(app).not.toMatch(/_sessionPassword/);
        expect(panel).not.toMatch(/_sessionPassword/);
        const cache = app.slice(app.indexOf('function cacheSessionCredentials'), app.indexOf('function getSessionCredentials'));
        expect(cache).toContain('reconnectToken');
        expect(cache).not.toMatch(/password/i);
    });
});
