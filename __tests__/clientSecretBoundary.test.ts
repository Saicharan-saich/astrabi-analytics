import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertNoClientSecrets } from '../config/clientEnvSecurity';

const readSource = (relativePath: string) => readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf8',
);

describe('browser secret boundary', () => {
    it('allows public frontend URLs', () => {
        expect(() => assertNoClientSecrets({
            VITE_API_URL: 'https://api.quickinsight.co.uk/api',
            VITE_API_BASE_URL: 'https://api.quickinsight.co.uk',
        })).not.toThrow();
    });

    it.each([
        'VITE_OPENROUTER_API_KEY',
        'VITE_API_KEY',
        'VITE_GEMINI_API_KEY',
        'VITE_SESSION_TOKEN',
        'VITE_DATABASE_URL',
    ])('rejects non-empty client credential %s', (name) => {
        expect(() => assertNoClientSecrets({ [name]: 'not-a-real-secret' }))
            .toThrow(/Refusing to expose secret-like frontend environment variable/);
    });

    it('does not contain legacy browser credential reads or Vite secret injection', () => {
        const browserSources = [
            readSource('services/analysisEngine.ts'),
            readSource('services/liveRefreshService.ts'),
            readSource('services/aiSQLService.ts'),
            readSource('services/ai-sql/intentPlanner.ts'),
            readSource('services/ai-sql/modelConfig.ts'),
            readSource('App.tsx'),
            readSource('store/useActivityStore.ts'),
            readSource('vite.config.ts'),
        ].join('\n');

        expect(browserSources).not.toMatch(/import\.meta\.env\.VITE_(?:OPENROUTER|API_KEY|GEMINI)/);
        expect(browserSources).not.toContain('process.env.API_KEY');
        expect(browserSources).not.toContain('process.env.GEMINI_API_KEY');
    });
});
