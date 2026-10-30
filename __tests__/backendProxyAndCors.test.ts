import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const server = readFileSync(join(process.cwd(), 'backend', 'server.js'), 'utf8');

describe('backend proxy and CORS configuration', () => {
    it('trusts the hosting proxy before any rate limiter runs', () => {
        const trust = server.indexOf("app.set('trust proxy'");
        const firstLimiter = server.indexOf('rateLimit(');
        expect(trust).toBeGreaterThan(-1);
        expect(trust).toBeLessThan(firstLimiter);
    });

    it('rejects unknown origins without throwing (no 500s or stack traces)', () => {
        const corsBlock = server.slice(server.indexOf('app.use(cors({'), server.indexOf('credentials: true'));
        expect(corsBlock).toContain('callback(null, false)');
        expect(corsBlock).not.toContain('callback(new Error');
    });
});
