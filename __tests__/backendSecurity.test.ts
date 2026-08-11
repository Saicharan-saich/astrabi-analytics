import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  allowedLlmModels,
  assertSafeDatabaseHost,
  createConnectionId,
  isPrivateOrReservedAddress,
  validateLlmRequest,
  validatePort,
} = require('../backend/security.js');

describe('backend security boundaries', () => {
  it('creates unguessable, namespaced connection identifiers', () => {
    const first = createConnectionId('pg');
    const second = createConnectionId('pg');
    expect(first).toMatch(/^pg_[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.4',
    '172.20.1.2',
    '192.168.1.10',
    '169.254.169.254',
    '::1',
    'fd00::1',
    'fe80::1',
  ])('blocks private or reserved address %s', (address) => {
    expect(isPrivateOrReservedAddress(address)).toBe(true);
  });

  it('allows a public database address and validates ports', async () => {
    expect(isPrivateOrReservedAddress('8.8.8.8')).toBe(false);
    await expect(assertSafeDatabaseHost('8.8.8.8', 5432)).resolves.toBe('8.8.8.8');
    expect(validatePort('1433', 5432)).toBe(1433);
    expect(() => validatePort('70000', 5432)).toThrow(/between 1 and 65535/);
  });

  it('rejects URL-shaped hosts before any outbound lookup', async () => {
    await expect(assertSafeDatabaseHost('https://example.com/db', 5432))
      .rejects.toThrow(/hostname or IP address/);
  });

  it('accepts only enabled models and bounded request parameters', () => {
    const models = allowedLlmModels();
    const accepted = validateLlmRequest({
      model: 'openai/gpt-5.6-terra',
      messages: [{ role: 'user', content: 'Plan sales by region' }],
      max_tokens: 1200,
      temperature: 0.1,
    }, models);
    expect(accepted.valid).toBe(true);

    expect(validateLlmRequest({
      model: 'untrusted/provider-model',
      messages: [{ role: 'user', content: 'test' }],
    }, models)).toMatchObject({ valid: false });

    expect(validateLlmRequest({
      model: 'openai/gpt-5.6-luna',
      messages: [{ role: 'tool', content: 'test' }],
    }, models)).toMatchObject({ valid: false });

    expect(validateLlmRequest({
      model: 'openai/gpt-5.6-sol',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 9000,
    }, models)).toMatchObject({ valid: false });
  });

  it('permits the existing bounded chart-image message shape', () => {
    const result = validateLlmRequest({
      model: 'google/gemini-2.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this chart' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }],
    }, allowedLlmModels());
    expect(result.valid).toBe(true);
  });
});
