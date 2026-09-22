import { describe, it, expect } from 'vitest';
import {
  buildSandboxEnv,
  composeSandboxEnvForTest,
  findSecretShapedEnvEntries,
  SANDBOX_BASE_ENV,
  SANDBOX_ENV_ALLOWLIST_TRIPWIRE,
} from '../sandbox-env';

// A validated-env shape carrying every category of host secret we must never
// leak into an untrusted sandbox.
const hostEnv = {
  NODE_ENV: 'production' as const,
  SENTRY_DSN: 'https://public@sentry.example/42',
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
    const env = composeSandboxEnvForTest(hostEnv, ['SENTRY_DSN']);
    expect(env.SENTRY_DSN).toBe(hostEnv.SENTRY_DSN);
    // Every other host key — every secret in the fixture — is still excluded by
    // construction, which is the assertion that was vacuous while the production
    // allowlist (and therefore the loop's input) was empty.
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('ENCRYPTION_KEY');
    expect(env).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(env).not.toHaveProperty('CRON_SECRET');
    expect(Object.keys(env).sort()).toEqual(['NODE_ENV', 'PYTHONUNBUFFERED', 'SENTRY_DSN']);
  });

  it('given an allowlisted key absent from the host env, should omit it rather than copy an undefined', () => {
    const env = composeSandboxEnvForTest({ DATABASE_URL: 'x' } as never, ['SENTRY_DSN']);
    expect(env).not.toHaveProperty('SENTRY_DSN');
    expect(Object.values(env).every((value) => typeof value === 'string')).toBe(true);
  });

  it('should not even let a caller NAME a secret as forwardable', () => {
    // A TYPE-level assertion, and deliberately so: `allowlist` is typed by
    // ForwardableEnvKey, a reviewed union of non-secret keys, so a test, a
    // refactor, or a mistake cannot turn this seam into a leak. The runtime does
    // not enforce it (the loop forwards whatever it is handed) — `tsc` does, and
    // `@ts-expect-error` IS the check: if the union ever widens far enough to
    // admit a secret, this directive becomes unused and the typecheck FAILS.
    type Allowlist = Parameters<typeof composeSandboxEnvForTest>[1];
    // @ts-expect-error ENCRYPTION_KEY is not a forwardable key
    const forbidden: Allowlist = ['ENCRYPTION_KEY'];
    const allowed: Allowlist = ['SENTRY_DSN'];
    expect([forbidden, allowed]).toHaveLength(2);
  });

  it('given a sandbox-owned key ON the allowlist, should still refuse the host value', () => {
    // The precedence that makes #2466 unrepeatable: even deliberately
    // forwarding NODE_ENV cannot put the host's mode back into a sandbox.
    const env = composeSandboxEnvForTest(hostEnv, ['NODE_ENV']);
    expect(env.NODE_ENV).toBe('development');
  });

  it('given a key is ever forwarded, should fail until both services have been considered', () => {
    // Not a behaviour test — a tripwire. Forwarding is a two-service decision:
    // the bash/git tools build from the WEB service's validated env, the
    // interactive terminal from the REALTIME service's raw process.env. A key
    // only one deployment sets (or only one side validates) puts the two
    // surfaces back to answering `env | grep X` differently, which is #2466.
    // If you are here because this failed: provision the key in BOTH services,
    // then update this expectation.
    expect(SANDBOX_ENV_ALLOWLIST_TRIPWIRE).toEqual([]);
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

// --- Sign in with PageSpace: the two PUBLIC values (US6, ADR 0004 Decision 12) ---
// A drive ENVIRONMENT hosts an app that signs users in through the platform-
// managed client `env_<envId>`. The sandbox learns where PageSpace is and which
// client it is through PAGESPACE_URL / PAGESPACE_CLIENT_ID — public values, so
// the no-secrets invariant above holds — and the secret-shape guard below is
// what keeps that sentence true as the map grows.

const ENV_ID = 'k3m9xq2p7r4t8v1w5y6z0a1b';
const hostWithUrl = { ...hostEnv, WEB_APP_URL: 'https://app.pagespace.ai' };

describe('buildSandboxEnv — sign-in values', () => {
  it('given an ENV sandbox, adds PAGESPACE_URL (the host app origin) and PAGESPACE_CLIENT_ID = env_<envId>, and nothing else', () => {
    const env = buildSandboxEnv({ env: hostWithUrl, signIn: { envId: ENV_ID } });
    expect(env.PAGESPACE_URL).toBe('https://app.pagespace.ai');
    expect(env.PAGESPACE_CLIENT_ID).toBe(`env_${ENV_ID}`);
    expect(Object.keys(env).sort()).toEqual(['NODE_ENV', 'PAGESPACE_CLIENT_ID', 'PAGESPACE_URL', 'PYTHONUNBUFFERED']);
  });

  it('given an ephemeral SESSION sandbox (no env), adds PAGESPACE_URL only — there is no client to name', () => {
    const env = buildSandboxEnv({ env: hostWithUrl, signIn: { envId: null } });
    expect(env.PAGESPACE_URL).toBe('https://app.pagespace.ai');
    expect(env).not.toHaveProperty('PAGESPACE_CLIENT_ID');
  });

  it('given no sign-in target at all (a caller that predates the seam), behaves exactly as before', () => {
    expect(buildSandboxEnv({ env: hostWithUrl })).toEqual({ ...SANDBOX_BASE_ENV, PAGESPACE_URL: 'https://app.pagespace.ai' });
    expect(buildSandboxEnv({ env: hostEnv })).toEqual(SANDBOX_BASE_ENV);
  });

  it('given a host with no usable WEB_APP_URL, omits PAGESPACE_URL rather than forwarding an empty string', () => {
    expect(buildSandboxEnv({ env: { ...hostEnv, WEB_APP_URL: '' }, signIn: { envId: ENV_ID } })).not.toHaveProperty('PAGESPACE_URL');
    expect(buildSandboxEnv({ env: hostEnv, signIn: { envId: ENV_ID } })).toEqual({ ...SANDBOX_BASE_ENV, PAGESPACE_CLIENT_ID: `env_${ENV_ID}` });
  });

  it('still lets no host key shadow a sandbox-owned value, and the sign-in values cannot either', () => {
    const env = composeSandboxEnvForTest({ ...hostWithUrl, NODE_ENV: 'production' }, ['NODE_ENV'], { envId: ENV_ID });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PAGESPACE_CLIENT_ID).toBe(`env_${ENV_ID}`);
  });
});

describe('secret-shape guard — a public client id is NOT a secret; anything secret-shaped fails this suite', () => {
  it('given the env sandbox map WITH PAGESPACE_CLIENT_ID set, finds no secret-shaped key or value (env_… is public)', () => {
    const env = buildSandboxEnv({ env: hostWithUrl, signIn: { envId: ENV_ID } });
    expect(findSecretShapedEnvEntries(env)).toEqual([]);
  });

  it('given the session sandbox map and the bare base, finds no secret-shaped key or value', () => {
    expect(findSecretShapedEnvEntries(buildSandboxEnv({ env: hostWithUrl, signIn: { envId: null } }))).toEqual([]);
    expect(findSecretShapedEnvEntries(SANDBOX_BASE_ENV)).toEqual([]);
  });

  it('control: flags a value shaped like an mcp_ key, a ps_ token or an sk_ key, and a key ending _TOKEN, _SECRET or _KEY', () => {
    // If this control ever passes on an empty list, the guard above is vacuous.
    expect(findSecretShapedEnvEntries({ SAFE: 'x', LEAK: 'ps_at_abcdef' })).toEqual([{ key: 'LEAK', reason: 'value_prefix' }]);
    expect(findSecretShapedEnvEntries({ A: 'mcp_1234' })).toEqual([{ key: 'A', reason: 'value_prefix' }]);
    expect(findSecretShapedEnvEntries({ A: 'sk_live_1' })).toEqual([{ key: 'A', reason: 'value_prefix' }]);
    expect(findSecretShapedEnvEntries({ A: 'ps_rt_1' })).toEqual([{ key: 'A', reason: 'value_prefix' }]);
    expect(findSecretShapedEnvEntries({ GITHUB_TOKEN: 'x' })).toEqual([{ key: 'GITHUB_TOKEN', reason: 'key_suffix' }]);
    expect(findSecretShapedEnvEntries({ CSRF_SECRET: 'x' })).toEqual([{ key: 'CSRF_SECRET', reason: 'key_suffix' }]);
    expect(findSecretShapedEnvEntries({ ENCRYPTION_KEY: 'x' })).toEqual([{ key: 'ENCRYPTION_KEY', reason: 'key_suffix' }]);
    expect(findSecretShapedEnvEntries({ stripe_secret_key: 'x' })).toEqual([{ key: 'stripe_secret_key', reason: 'key_suffix' }]);
    // The ONE public value that looks adjacent: env_ is not on the list, and _ID is not a secret suffix.
    expect(findSecretShapedEnvEntries({ PAGESPACE_CLIENT_ID: 'env_abc' })).toEqual([]);
  });
});

