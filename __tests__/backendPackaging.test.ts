import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('standalone backend deployment', () => {
    it('loads dashboard persistence and sanitizes results without the frontend repository', () => {
        const source = fileURLToPath(new URL('../backend/', import.meta.url));
        const prefix = path.join(tmpdir(), 'quickinsight-backend-package-');
        const deployment = mkdtempSync(prefix);
        try {
            // Railway deploys backend/ as /app. Copy only its runtime modules;
            // there is deliberately no sibling shared/ directory or node_modules.
            for (const file of readdirSync(source)) {
                if (/\.(?:js|mjs)$/.test(file) || file === 'package.json') {
                    copyFileSync(path.join(source, file), path.join(deployment, file));
                }
            }
            const output = execFileSync(process.execPath, ['-e', `
                const { sanitizeStoredDashboards } = require('./dashboardPersistence.js');
                sanitizeStoredDashboards([{ id: 'test', items: [{ id: 'card', result: {
                    sql: 'SELECT sales FROM data', data: [{ sales: 'PRIVATE_RESULT' }]
                } }] }]).then(rows => process.stdout.write(JSON.stringify(rows)))
                  .catch(error => { console.error(error); process.exitCode = 1; });
            `], { cwd: deployment, encoding: 'utf8', timeout: 10_000 });
            expect(output).not.toContain('PRIVATE_RESULT');
            expect(JSON.parse(output)[0].items[0].result).toMatchObject({
                sql: 'SELECT sales FROM data', data: [], needsLocalData: true,
            });
        } finally {
            if (!path.resolve(deployment).startsWith(path.resolve(prefix))) throw new Error('Invalid test directory');
            rmSync(deployment, { recursive: true, force: true });
        }
    });
});
