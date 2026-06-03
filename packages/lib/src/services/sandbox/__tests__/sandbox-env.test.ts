import { describe, it, expect } from 'vitest';
import { buildSandboxEnv } from '../sandbox-env';

// A validated-env shape carrying every category of host secret we must never
// leak into an untrusted sandbox.
const hostEnv = {
  NODE_ENV: 'production' as const,
  DATABASE_URL: 'postgresql://user:supersecret@db.internal:5432/app',
  CSRF_SECRET: 'csrf-secret-value-that-is-long-enough-aaaaa',
  ENCRYPTION_KEY: 'encryption-key-value-that-is-long-enough-bbbb',
  STRIPE_SECRET_KEY: 'fake-stripe-secret-key-deadbeefdeadbeef',
  STRIPE_WEBHOOK_SECRET: 'fake-stripe-webhook-secret-deadbeef',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-oauth-secret',
  GOOGLE_AI_DEFAULT_API_KEY: 'ai-key-123',
  OPENROUTER_DEFAULT_API_KEY: 'or-key-456',
  REALTIME_BROADCAST_SECRET: 'rt-secret',
  CRON_SECRET: 'cron-secret',
  OAUTH_STATE_SECRET: 'oauth-state-secret-long-enough-cccccccccccc',
};

describe('buildSandboxEnv', () => {
  it('should not pass any host secret, DB credential, or key into the sandbox', () => {
    const env = buildSandboxEnv({ env: hostEnv });
    const forbidden = [
      'DATABASE_URL',
      'CSRF_SECRET',
      'ENCRYPTION_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'GOOGLE_AI_DEFAULT_API_KEY',
      'OPENROUTER_DEFAULT_API_KEY',
      'REALTIME_BROADCAST_SECRET',
      'CRON_SECRET',
      'OAUTH_STATE_SECRET',
    ];
    for (const key of forbidden) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('should not leak any secret VALUE even under an unexpected key', () => {
    const env = buildSandboxEnv({ env: hostEnv });
    const serialized = JSON.stringify(env);
    const secretValues = [
      'supersecret',
      hostEnv.CSRF_SECRET,
      hostEnv.ENCRYPTION_KEY,
      hostEnv.STRIPE_SECRET_KEY,
      hostEnv.GOOGLE_AI_DEFAULT_API_KEY,
      hostEnv.OPENROUTER_DEFAULT_API_KEY,
    ];
    for (const value of secretValues) {
      expect(serialized).not.toContain(value);
    }
  });

  it('should only expose explicitly allowlisted, non-secret keys', () => {
    const env = buildSandboxEnv({ env: hostEnv });
    expect(Object.keys(env)).toEqual(['NODE_ENV']);
    expect(env.NODE_ENV).toBe('production');
  });

  it('should ignore arbitrary extra keys present on the input env', () => {
    const env = buildSandboxEnv({
      env: { ...hostEnv, SOME_INJECTED_SECRET: 'leak-me' } as never,
    });
    expect(JSON.stringify(env)).not.toContain('leak-me');
  });

  it('should produce a string-valued record safe to hand to the sandbox', () => {
    const env = buildSandboxEnv({ env: hostEnv });
    for (const value of Object.values(env)) {
      expect(typeof value).toBe('string');
    }
  });

  it('given an empty injected env, should return an empty record without reading any global or throwing (pure)', () => {
    // The validated env is injected, never read from a global here, so an empty
    // input yields an empty result deterministically — no NODE_ENV leaks in from
    // the host process and the call cannot throw on a missing/invalid global.
    expect(buildSandboxEnv({ env: {} })).toEqual({});
  });

  it('given the allowlisted key absent, should omit it rather than copy an undefined', () => {
    const env = buildSandboxEnv({ env: { DATABASE_URL: 'x' } as never });
    expect(env).not.toHaveProperty('NODE_ENV');
  });
});
