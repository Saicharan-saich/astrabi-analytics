/**
 * Vite exposes every VITE_* variable to browser JavaScript. Reject names that
 * look like credentials before a production or local build can publish them.
 */
const CLIENT_SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PRIVATE|DATABASE_URL)/i;

export function assertNoClientSecrets(env: Record<string, string | undefined>): void {
    const forbidden = Object.entries(env)
        .filter(([name, value]) => name.startsWith('VITE_') && Boolean(value) && CLIENT_SECRET_NAME.test(name))
        .map(([name]) => name)
        .sort();

    if (forbidden.length > 0) {
        throw new Error(
            `Refusing to expose secret-like frontend environment variable(s): ${forbidden.join(', ')}. `
            + 'Move credentials to an unprefixed backend environment variable.'
        );
    }
}
