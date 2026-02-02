/**
 * Credential Encryption Tests
 *
 * Tests for encryptCredentials and decryptCredentials - wrapper functions
 * that encrypt/decrypt Record<string, string> credential objects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encryptCredentials, decryptCredentials } from './encrypt-credentials';

// Mock the underlying encryption utilities
vi.mock('../../encryption/encryption-utils', () => ({
  encrypt: vi.fn(async (text: string) => `encrypted:${text}`),
  decrypt: vi.fn(async (text: string) => text.replace('encrypted:', '')),
}));

describe('encryptCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given empty credentials object, should return empty object', async () => {
    const credentials = {};

    const result = await encryptCredentials(credentials);

    expect(result).toEqual({});
  });

  it('given single credential, should encrypt the value', async () => {
    const credentials = { token: 'secret-token-123' };

    const result = await encryptCredentials(credentials);

    expect(result).toEqual({ token: 'encrypted:secret-token-123' });
  });

  it('given multiple credentials, should encrypt all values', async () => {
    const credentials = {
      apiKey: 'key-abc',
      secret: 'secret-xyz',
      accessToken: 'token-123',
    };

    const result = await encryptCredentials(credentials);

    expect(result).toEqual({
      apiKey: 'encrypted:key-abc',
      secret: 'encrypted:secret-xyz',
      accessToken: 'encrypted:token-123',
    });
  });

  it('given credentials with empty string value, should encrypt empty string', async () => {
    const credentials = { emptyField: '' };

    const result = await encryptCredentials(credentials);

    expect(result).toEqual({ emptyField: 'encrypted:' });
  });

  it('given credentials, should not mutate original object', async () => {
    const original = { token: 'secret' };
    const credentials = { ...original };

    await encryptCredentials(credentials);

    expect(credentials).toEqual(original);
  });
});

describe('decryptCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given empty encrypted credentials, should return empty object', async () => {
    const encrypted = {};

    const result = await decryptCredentials(encrypted);

    expect(result).toEqual({});
  });

  it('given single encrypted credential, should decrypt the value', async () => {
    const encrypted = { token: 'encrypted:secret-token-123' };

    const result = await decryptCredentials(encrypted);

    expect(result).toEqual({ token: 'secret-token-123' });
  });

  it('given multiple encrypted credentials, should decrypt all values', async () => {
    const encrypted = {
      apiKey: 'encrypted:key-abc',
      secret: 'encrypted:secret-xyz',
      accessToken: 'encrypted:token-123',
    };

    const result = await decryptCredentials(encrypted);

    expect(result).toEqual({
      apiKey: 'key-abc',
      secret: 'secret-xyz',
      accessToken: 'token-123',
    });
  });

  it('given encrypted credentials, should not mutate original object', async () => {
    const original = { token: 'encrypted:secret' };
    const encrypted = { ...original };

    await decryptCredentials(encrypted);

    expect(encrypted).toEqual(original);
  });
});

describe('encrypt/decrypt roundtrip', () => {
  // Reset mocks to test real encryption/decryption behavior
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('given credentials encrypted then decrypted, should return original values', async () => {
    // Use a more realistic mock that simulates actual encryption behavior
    const { encrypt, decrypt } = await import('../../encryption/encryption-utils');
    const encryptMock = vi.mocked(encrypt);
    const decryptMock = vi.mocked(decrypt);

    // Setup mocks to track encrypted values
    const encryptedMap = new Map<string, string>();
    let counter = 0;

    encryptMock.mockImplementation(async (text: string) => {
      const encrypted = `enc_${counter++}_${Buffer.from(text).toString('base64')}`;
      encryptedMap.set(encrypted, text);
      return encrypted;
    });

    decryptMock.mockImplementation(async (encrypted: string) => {
      const original = encryptedMap.get(encrypted);
      if (!original && original !== '') throw new Error('Invalid encrypted value');
      return original!;
    });

    const original = {
      apiKey: 'my-api-key',
      secret: 'my-secret',
      token: 'my-token',
    };

    const encrypted = await encryptCredentials(original);
    const decrypted = await decryptCredentials(encrypted);

    expect(decrypted).toEqual(original);
  });
});
