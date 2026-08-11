/**
 * The auth store is compiled into the browser bundle, so anything in it is
 * readable by every visitor. It previously shipped a seeded ADMIN account whose
 * password was the literal string 'password'.
 *
 * These tests fail if that ever comes back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Strip comments so prose about the fix cannot satisfy or trip a check.
 *
 * Block comments are matched only at the start of a line. server.js contains
 * a PostgreSQL URL with redacted credentials in a helper, and an unanchored
 * /\*…\*\/ treats that as a comment opener and eats the next 16k characters —
 * including the code these tests exist to check.
 */
const stripComments = (src: string) => src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

const SRC = readFileSync(join(process.cwd(), 'store/useAuthStore.ts'), 'utf8');
const code = stripComments(SRC);

describe('auth store ships no credentials', () => {
    it('does not hash a hard-coded password literal', () => {
        // e.g. secureHash('password') / legacyHash("hunter2")
        expect(code).not.toMatch(/(secureHash|legacyHash)\s*\(\s*['"][^'"]+['"]\s*\)/);
    });

    it('starts with an empty user list', () => {
        const m = code.match(/users:\s*(\[[^\]]*\]|[A-Z_a-z]+)\s*,/);
        expect(m, 'could not find the initial users array').toBeTruthy();
        const init = m![1];
        // Either a literal empty array, or the named empty constant.
        expect(init === '[]' || init === 'SEEDED_ACCOUNTS').toBe(true);
        if (init === 'SEEDED_ACCOUNTS') {
            expect(code).toMatch(/const\s+SEEDED_ACCOUNTS\s*:\s*User\[\]\s*=\s*\[\s*\]/);
        }
    });

    it('contains no passwordHash assigned from a literal', () => {
        expect(code).not.toMatch(/passwordHash:\s*['"][^'"]+['"]/);
    });

    it('embeds no real email address as a seeded account', () => {
        // Guest and revocation lists are allowed; a personal address is not.
        const emails = [...code.matchAll(/['"]([\w.+-]+@[\w.-]+\.\w+)['"]/g)].map(m => m[1].toLowerCase());
        const allowed = new Set(['guest@quickinsight.app', 'saicharan@quickinsight.co.uk']);
        expect(emails.filter(e => !allowed.has(e))).toEqual([]);
        // The one allowed non-guest address may appear ONLY in the revocation list.
        if (emails.includes('saicharan@quickinsight.co.uk')) {
            expect(code).toMatch(/REVOKED_SEED_EMAILS\s*=\s*\[[^\]]*saicharan@quickinsight\.co\.uk/);
        }
    });

    it('purges a previously persisted seed account on upgrade', () => {
        expect(code).toMatch(/version:\s*1/);
        expect(code).toMatch(/migrate:/);
        expect(code).toMatch(/REVOKED_SEED_EMAILS/);
    });
});

describe('backend seeds no default admin', () => {
    const serverCode = stripComments(readFileSync(join(process.cwd(), 'backend/server.js'), 'utf8'));

    it('never hashes a hard-coded password', () => {
        expect(serverCode).not.toMatch(/bcrypt\.hash\s*\(\s*['"][^'"]+['"]/);
    });

    it('takes the admin account from the environment', () => {
        expect(serverCode).toMatch(/process\.env\.ADMIN_EMAIL/);
        expect(serverCode).toMatch(/process\.env\.ADMIN_PASSWORD/);
    });

    it('refuses to start in production without JWT_SECRET', () => {
        expect(serverCode).toMatch(/IS_PRODUCTION\s*&&\s*!process\.env\.JWT_SECRET/);
        expect(serverCode).toMatch(/process\.exit\(1\)/);
    });
});
