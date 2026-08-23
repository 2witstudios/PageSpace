import { describe, it, expect } from 'vitest';
import { buildSandboxEnv, SANDBOX_BASE_ENV } from '../sandbox-env';

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

  it('should only expose sandbox-owned, non-secret keys', () => {
    const env = buildSandboxEnv({ env: hostEnv });
    expect(Object.keys(env).sort()).toEqual(['NODE_ENV', 'PYTHONUNBUFFERED']);
  });

  it('given a host running in production, should still describe the sandbox as a development machine', () => {
    // #2466: the sandbox used to inherit the host's NODE_ENV, so a sandbox opened
    // from the production web server reported NODE_ENV=production — under which
    // npm silently drops devDependencies, leaving tsx/vitest/tsc missing after a
    // plain `npm install`. The host's mode is not a fact about the sandbox.
    const env = buildSandboxEnv({ env: hostEnv });
    expect(hostEnv.NODE_ENV).toBe('production');
    expect(env.NODE_ENV).toBe('development');
  });

  it('should unbuffer python stdout so a piped long job is visible before it exits', () => {
    // #2468: CPython block-buffers stdout when it is a pipe rather than a tty, so
    // `python … | grep -v noise` shows nothing in the pane until exit.
    expect(buildSandboxEnv({ env: hostEnv }).PYTHONUNBUFFERED).toBe('1');
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

  it('given an empty injected env, should return exactly the sandbox-owned base without reading any global or throwing (pure)', () => {
    // The validated env is injected, never read from a global here, so the result
    // is the sandbox's own base and nothing else — no host value leaks in through
    // process.env, and the call cannot throw on a missing/invalid global.
    expect(buildSandboxEnv({ env: {} })).toEqual(SANDBOX_BASE_ENV);
  });

  // --- the forwarding rule itself -------------------------------------------
  // The production allowlist is empty, so every assertion above is about a
  // machine with nothing to forward: they would all pass against a
  // `buildSandboxEnv` whose loop had been deleted. These three hand in a fixture
  // allowlist so the rule that guards the day a key is added back — only
  // allowlisted keys pass, nothing else does, and sandbox-owned values still win
  // — is actually exercised.

  it('given a non-empty allowlist, should forward exactly those keys and no others', () => {
    const env = buildSandboxEnv({ env: hostEnv, allowlist: ['SENTRY_DSN', 'CRON_SECRET'] });
    expect(env.CRON_SECRET).toBe(hostEnv.CRON_SECRET);
    // Every other host key — secrets included — is still excluded by construction.
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('ENCRYPTION_KEY');
    expect(env).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(Object.keys(env).sort()).toEqual(['CRON_SECRET', 'NODE_ENV', 'PYTHONUNBUFFERED']);
  });

  it('given an allowlisted key absent from the host env, should omit it rather than copy an undefined', () => {
    const env = buildSandboxEnv({ env: { DATABASE_URL: 'x' } as never, allowlist: ['SENTRY_DSN'] });
    expect(env).not.toHaveProperty('SENTRY_DSN');
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
  });

  it('given a sandbox-owned key ON the allowlist, should still refuse the host value', () => {
    // The precedence that makes #2466 unrepeatable: even deliberately
    // forwarding NODE_ENV cannot put the host's mode back into a sandbox.
    const env = buildSandboxEnv({ env: hostEnv, allowlist: ['NODE_ENV'] });
    expect(env.NODE_ENV).toBe('development');
  });

  it('should not let any host key shadow a sandbox-owned value', () => {
    // Sandbox-owned values are applied last precisely so a future allowlist entry
    // (or a host env that happens to carry the same key) cannot overwrite one.
    const env = buildSandboxEnv({
      env: { NODE_ENV: 'production', PYTHONUNBUFFERED: '0' } as never,
    });
    expect(env).toEqual(SANDBOX_BASE_ENV);
  });
});
