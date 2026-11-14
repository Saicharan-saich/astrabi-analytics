/**
 * Account lifecycle on the backend, against an in-memory stand-in for the
 * database: 30-day sliding sessions, password reset by a one-time link, and
 * the right to download and delete everything held about an account.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createAccountService, sha256 } = require('../backend/accounts.js');

type User = { id: string; email: string; name: string; role: string; password_hash: string; session_version: number; is_active: boolean };
type Reset = { token_hash: string; user_id: string; expires_at: number; used_at: number | null };

function fakeDb() {
    const users: User[] = [];
    let resets: Reset[] = [];
    const deleted: string[] = [];
    const query = async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (/^SELECT id, email, name, is_active FROM users WHERE email/.test(s)) return { rows: users.filter(u => u.email === params[0]) };
        if (/^DELETE FROM password_resets WHERE user_id/.test(s)) { resets = resets.filter(r => !(r.user_id === params[0] && r.used_at === null)); return { rows: [] }; }
        if (/^INSERT INTO password_resets/.test(s)) { resets.push({ token_hash: params[0], user_id: params[1], expires_at: Date.now() + Number(params[2]) * 60_000, used_at: null }); return { rows: [] }; }
        if (/^SELECT r\.user_id/.test(s)) {
            const r = resets.find(x => x.token_hash === params[0] && x.used_at === null && x.expires_at > Date.now());
            const u = r && users.find(x => x.id === r.user_id);
            return { rows: r && u ? [{ user_id: u.id, email: u.email, name: u.name, role: u.role, is_active: u.is_active }] : [] };
        }
        if (/^UPDATE users SET password_hash = \$1, session_version = session_version \+ 1 WHERE id = \$2 RETURNING/.test(s)) {
            const u = users.find(x => x.id === params[1])!;
            u.password_hash = params[0]; u.session_version += 1;
            return { rows: [{ id: u.id, email: u.email, name: u.name, role: u.role, session_version: u.session_version }] };
        }
        if (/^UPDATE password_resets SET used_at/.test(s)) { resets.filter(r => r.token_hash === params[0]).forEach(r => { r.used_at = Date.now(); }); return { rows: [] }; }
        if (/^SELECT id, role, password_hash FROM users WHERE id/.test(s)) return { rows: users.filter(u => u.id === params[0]) };
        if (/^SELECT COUNT\(\*\)::int AS n FROM users WHERE role = 'admin'/.test(s)) return { rows: [{ n: users.filter(u => u.role === 'admin' && u.is_active).length }] };
        if (/^SELECT id, email, name, role, is_active, daily_ai_limit, created_at FROM users WHERE id/.test(s)) return { rows: users.filter(u => u.id === params[0]).map(({ password_hash, ...rest }) => rest) };
        if (/^SELECT .* FROM (dashboards|usage_logs|user_activities|subscriptions)/.test(s)) return { rows: [] };
        throw new Error(`unexpected query: ${s}`);
    };
    const pool = {
        query,
        connect: async () => ({
            query: async (sql: string, params: any[] = []) => {
                const s = sql.replace(/\s+/g, ' ').trim();
                if (/^DELETE FROM users WHERE id/.test(s)) { const i = users.findIndex(u => u.id === params[0]); if (i >= 0) { deleted.push(users[i].id); users.splice(i, 1); } resets = resets.filter(r => r.user_id !== params[0]); }
                return { rows: [] };
            },
            release: () => {},
        }),
    };
    return { pool, users, resets: () => resets, deleted };
}

// Stand-ins for jsonwebtoken and bcryptjs: the service only uses sign() and hash()/compare().
const jwt = {
    sign: (payload: any, _secret: string, options: any) => `t.${Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: options.expiresIn })).toString('base64url')}`,
};
const bcrypt = { hash: async (p: string) => `h:${p}`, compare: async (p: string, h: string) => h === `h:${p}` };
const decode = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

let db: ReturnType<typeof fakeDb>;
let service: any;
beforeEach(() => {
    db = fakeDb();
    db.users.push(
        { id: 'u1', email: 'owner@shop.co.uk', name: 'Owner', role: 'contributor', password_hash: 'h:oldpassword', session_version: 1, is_active: true },
        { id: 'a1', email: 'admin@quickinsight.co.uk', name: 'Admin', role: 'admin', password_hash: 'h:adminpassword', session_version: 1, is_active: true },
    );
    service = createAccountService({ jwt, secret: 's', bcrypt, rounds: 4, getPool: () => db.pool, isProduction: false, appUrl: () => 'https://quickinsight.co.uk' });
});

describe('sessions', () => {
    it('last 30 days and are renewed once a day while in use', () => {
        const token = service.issueToken(db.users[0]);
        expect(decode(token)).toMatchObject({ userId: 'u1', sv: 1, exp: '30d' });
        expect(service.renewedToken({ iat: Math.floor(Date.now() / 1000) - 3600 }, db.users[0])).toBeNull();
        expect(service.renewedToken({ iat: Math.floor(Date.now() / 1000) - 2 * 86400 }, db.users[0])).toMatch(/^t\./);
    });
    it('need passwords of at least 8 characters', () => {
        expect(service.passwordProblem('short')).toMatch(/at least 8/);
        expect(service.passwordProblem('long enough')).toBeNull();
    });
});

describe('password reset', () => {
    it('says the same thing whether or not the email has an account, and emails only real ones', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(await service.requestReset('nobody@example.com')).toEqual({ ok: true });
        expect(db.resets()).toHaveLength(0);
        expect(await service.requestReset('Owner@Shop.co.uk ')).toEqual({ ok: true });
        expect(db.resets()).toHaveLength(1);
        const printed = log.mock.calls.map(c => String(c[0])).join('\n');
        expect(printed).toMatch(/To: owner@shop\.co\.uk/);
        expect(printed).toMatch(/https:\/\/quickinsight\.co\.uk\/\?reset=/);
        // Only a hash of the link is stored.
        const token = decodeURIComponent(printed.match(/\?reset=([^\s]+)/)![1]);
        expect(db.resets()[0].token_hash).toBe(sha256(token));
        log.mockRestore();
    });

    it('sets the new password once, ends every other session, and signs this one in', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await service.requestReset('owner@shop.co.uk');
        const token = decodeURIComponent(log.mock.calls.map(c => String(c[0])).join('\n').match(/\?reset=([^\s]+)/)![1]);
        log.mockRestore();
        const weak = await service.completeReset(token, 'short');
        expect(weak.ok).toBe(false);
        expect(weak.error).toMatch(/at least 8/);
        const done = await service.completeReset(token, 'brand new password');
        expect(done).toMatchObject({ ok: true, user: { id: 'u1' } });
        expect(db.users[0].password_hash).toBe('h:brand new password');
        expect(db.users[0].session_version).toBe(2);
        expect(decode(done.token).sv).toBe(2);
        const again = await service.completeReset(token, 'another password');
        expect(again.ok).toBe(false);
        expect(again.error).toMatch(/expired or was already used/);
    });

    it('a second request makes the first link stop working', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        await service.requestReset('owner@shop.co.uk');
        const first = decodeURIComponent(String(log.mock.calls.at(-1)![0]).match(/\?reset=([^\s]+)/)![1]);
        await service.requestReset('owner@shop.co.uk');
        log.mockRestore();
        expect(await service.completeReset(first, 'brand new password')).toMatchObject({ ok: false });
    });
});

describe('your data', () => {
    it('can be downloaded, without the password hash and with a note about uploaded files', async () => {
        const data = await service.exportAccount('u1');
        expect(data.profile).toMatchObject({ id: 'u1', email: 'owner@shop.co.uk' });
        expect(JSON.stringify(data)).not.toMatch(/password|h:old/);
        expect(data.note).toMatch(/never sent to the server/);
    });

    it('is deleted with the account, after the password, and the last admin cannot delete themselves', async () => {
        expect(await service.deleteAccount('u1', 'wrong')).toMatchObject({ ok: false, status: 401 });
        const lastAdmin = await service.deleteAccount('a1', 'adminpassword');
        expect(lastAdmin.ok).toBe(false);
        expect(lastAdmin.error).toMatch(/only admin/);
        expect(await service.deleteAccount('u1', 'oldpassword')).toEqual({ ok: true });
        expect(db.deleted).toEqual(['u1']);
        expect(db.users.map(u => u.id)).toEqual(['a1']);
    });
});
