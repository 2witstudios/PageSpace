/**
 * Platform-managed OAuth client per environment (ADR 0004 Decision 12, [D-9],
 * [D-10]) — the pure half.
 *
 * Two assertions here are load-bearing and are mutation-checked on the leaf
 * page: every redirect the derivation emits passes the Phase 0
 * `validateRedirectUri` AS A NON-FIRST-PARTY CLIENT (so the platform can never
 * provision a redirect the authorize endpoint refuses, or one only a
 * first-party client may hold), and the whole derived row passes the Phase 0
 * `validateClientRegistration` (so the scope cap and the name rule cannot
 * drift from what a registered third party is held to).
 */
import { describe, it, expect } from 'vitest';
import { validateRedirectUri } from '../../../auth/oauth/clients';
import { validateClientRegistration } from '../../../auth/oauth/client-registration';
import {
  applyPendingRemoval,
  liveEnvRedirectUris,
  parseEnvOAuthClientId,
  deriveEnvClient,
  ENV_OAUTH_CALLBACK_PATH,
  ENV_OAUTH_CLIENT_ID_PREFIX,
  ENV_OAUTH_CLIENT_SCOPES,
  envOAuthClientId,
  envRedirectUris,
  retireEnvOAuthClient,
  signInEnvFor,
  syncEnvOAuthClient,
  type EnvClientHosting,
  type EnvOAuthClientRow,
  type EnvOAuthClientStore,
} from '../env-oauth-client';

const ENV_ID = 'k3m9xq2p7r4t8v1w5y6z0a1b';
const OWNER_ID = 'user_owner_1';
const env = { id: ENV_ID, name: 'staging' };
const previewOnly: EnvClientHosting = { previewApex: 'pagespace-preview.app', published: null };
const published: EnvClientHosting = {
  previewApex: 'pagespace-preview.app',
  published: { subdomain: 'staging-4f2', apex: 'pagespace.io', customDomains: [] },
};
const publishedWithDomains: EnvClientHosting = {
  previewApex: 'pagespace-preview.app',
  published: { subdomain: 'staging-4f2', apex: 'pagespace.io', customDomains: ['App.Example.com', 'app.example.com', 'shop.example.org'] },
};

const PREVIEW_CB = `https://env-${ENV_ID}.preview.pagespace-preview.app/auth/pagespace/callback`;
const PUBLISHED_CB = 'https://staging-4f2.pagespace.io/auth/pagespace/callback';

describe('envOAuthClientId', () => {
  it('is the env id under the env_ prefix — a public value, derivable by anything that knows the env', () => {
    expect(ENV_OAUTH_CLIENT_ID_PREFIX).toBe('env_');
    expect(envOAuthClientId(ENV_ID)).toBe(`env_${ENV_ID}`);
  });
});

describe('deriveEnvClient', () => {
  it('returns the oauth_clients row shape for an env: public, verified, never first-party, owned by the drive owner', () => {
    const row = deriveEnvClient({ env, driveOwnerId: OWNER_ID }, previewOnly);
    expect(row).toEqual({
      clientId: `env_${ENV_ID}`,
      name: 'staging',
      clientType: 'public',
      redirectUris: [PREVIEW_CB],
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role'],
      ownerUserId: OWNER_ID,
      verified: true,
      isFirstParty: false,
    } satisfies EnvOAuthClientRow);
  });

  it('caps the client at the third-party scope SHAPES only — never account, manage_keys, all_drives or a key operation', () => {
    const row = deriveEnvClient({ env, driveOwnerId: OWNER_ID }, previewOnly);
    expect(row.allowedScopes).toEqual([...ENV_OAUTH_CLIENT_SCOPES]);
    for (const forbidden of ['account', 'manage_keys', 'all_drives', 'update_key', 'activate_key', 'name']) {
      expect(row.allowedScopes.some((s) => s === forbidden || s.startsWith(`${forbidden}:`))).toBe(false);
    }
    // No device-code grant: an env-hosted web app signs in through the browser only.
    expect(row.allowedGrantTypes).not.toContain('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('given only a preview apex, emits the preview origin callback at the [D-10] path and nothing else', () => {
    expect(ENV_OAUTH_CALLBACK_PATH).toBe('/auth/pagespace/callback');
    expect(envRedirectUris(ENV_ID, previewOnly)).toEqual([PREVIEW_CB]);
  });

  it('given a published_apps row, ADDS the published callback without dropping the preview one', () => {
    expect(envRedirectUris(ENV_ID, published)).toEqual([PREVIEW_CB, PUBLISHED_CB]);
  });

  it('given verified custom domains, appends one callback per domain, lowercased and deduplicated', () => {
    expect(envRedirectUris(ENV_ID, publishedWithDomains)).toEqual([
      PREVIEW_CB,
      PUBLISHED_CB,
      'https://app.example.com/auth/pagespace/callback',
      'https://shop.example.org/auth/pagespace/callback',
    ]);
  });

  it('given no preview apex configured, emits no preview redirect (a host that does not exist cannot be a redirect)', () => {
    expect(envRedirectUris(ENV_ID, { previewApex: null, published: published.published })).toEqual([PUBLISHED_CB]);
    expect(envRedirectUris(ENV_ID, { previewApex: null, published: null })).toEqual([]);
  });

  it('every redirect it emits passes the Phase 0 validateRedirectUri as a NON-first-party client, so it can never drift from what authorize honours', () => {
    const hostings: EnvClientHosting[] = [
      previewOnly,
      published,
      publishedWithDomains,
      { previewApex: null, published: published.published },
      { previewApex: 'preview.example.co.uk', published: { subdomain: 'a1', apex: 'apps.example.co.uk', customDomains: ['xn--caf-dma.example'] } },
    ];
    let checked = 0;
    for (const hosting of hostings) {
      for (const uri of envRedirectUris(ENV_ID, hosting)) {
        expect(validateRedirectUri({ redirectUris: [uri], firstParty: false }, uri), uri).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it('the whole derived row passes the Phase 0 validateClientRegistration — the same bar a registered third party is held to', () => {
    for (const hosting of [previewOnly, published, publishedWithDomains]) {
      const row = deriveEnvClient({ env, driveOwnerId: OWNER_ID }, hosting);
      const result = validateClientRegistration({ name: row.name, redirectUris: row.redirectUris, allowedScopes: row.allowedScopes });
      expect(result, JSON.stringify(result)).toEqual({ ok: true, value: { name: row.name, redirectUris: row.redirectUris, allowedScopes: row.allowedScopes } });
    }
  });

  it('given an env name the consent screen must not render (bidi override, whitespace-only), falls back to a safe platform name', () => {
    const hostile = deriveEnvClient({ env: { id: ENV_ID, name: 'prod‮gnitset' }, driveOwnerId: OWNER_ID }, previewOnly);
    expect(hostile.name).toBe('PageSpace environment');
    const blank = deriveEnvClient({ env: { id: ENV_ID, name: '   ' }, driveOwnerId: OWNER_ID }, previewOnly);
    expect(blank.name).toBe('PageSpace environment');
    expect(validateClientRegistration({ name: hostile.name, redirectUris: hostile.redirectUris, allowedScopes: hostile.allowedScopes }).ok).toBe(true);
  });

  it('is pure: same inputs give a deep-equal row, and the inputs are not mutated', () => {
    const hosting: EnvClientHosting = { ...publishedWithDomains, published: { ...publishedWithDomains.published!, customDomains: [...publishedWithDomains.published!.customDomains] } };
    const snapshot = JSON.stringify(hosting);
    const a = deriveEnvClient({ env, driveOwnerId: OWNER_ID }, hosting);
    const b = deriveEnvClient({ env, driveOwnerId: OWNER_ID }, hosting);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(JSON.stringify(hosting)).toBe(snapshot);
  });
});

describe('signInEnvFor — the two PUBLIC values an app reads', () => {
  it('given an env and the PageSpace origin, yields exactly PAGESPACE_URL and PAGESPACE_CLIENT_ID', () => {
    expect(signInEnvFor({ envId: ENV_ID, pagespaceUrl: 'https://app.pagespace.ai' })).toEqual({
      PAGESPACE_URL: 'https://app.pagespace.ai',
      PAGESPACE_CLIENT_ID: `env_${ENV_ID}`,
    });
  });

  it('given no env (an ephemeral session sandbox), yields the URL only — there is no client to name', () => {
    expect(signInEnvFor({ envId: null, pagespaceUrl: 'https://app.pagespace.ai' })).toEqual({ PAGESPACE_URL: 'https://app.pagespace.ai' });
  });

  it('given an unset or non-URL origin, omits PAGESPACE_URL rather than emitting a value fromEnvironment would reject', () => {
    expect(signInEnvFor({ envId: ENV_ID, pagespaceUrl: undefined })).toEqual({ PAGESPACE_CLIENT_ID: `env_${ENV_ID}` });
    expect(signInEnvFor({ envId: ENV_ID, pagespaceUrl: '' })).toEqual({ PAGESPACE_CLIENT_ID: `env_${ENV_ID}` });
    expect(signInEnvFor({ envId: ENV_ID, pagespaceUrl: 'not a url' })).toEqual({ PAGESPACE_CLIENT_ID: `env_${ENV_ID}` });
  });

  it('normalizes the origin: trailing slashes and a path are dropped, so the SDK builds clean endpoint URLs', () => {
    expect(signInEnvFor({ envId: null, pagespaceUrl: 'https://app.pagespace.ai/' })).toEqual({ PAGESPACE_URL: 'https://app.pagespace.ai' });
    expect(signInEnvFor({ envId: null, pagespaceUrl: 'http://localhost:3000/dashboard' })).toEqual({ PAGESPACE_URL: 'http://localhost:3000' });
  });

  it('never carries anything secret-shaped: both values are the env id and an origin', () => {
    const values = Object.values(signInEnvFor({ envId: ENV_ID, pagespaceUrl: 'https://app.pagespace.ai' }));
    for (const value of values) expect(value).not.toMatch(/^(mcp_|ps_|sk_)/);
  });
});

// ---------------------------------------------------------------------------
// The I/O half, over an injected store
// ---------------------------------------------------------------------------

function fakeStore() {
  const rows = new Map<string, EnvOAuthClientRow & { disabledAt: Date | null }>();
  const calls: Array<{ op: 'upsert' | 'disable'; clientId: string }> = [];
  const store: EnvOAuthClientStore = {
    async upsert(row) {
      calls.push({ op: 'upsert', clientId: row.clientId });
      rows.set(row.clientId, { ...row, redirectUris: [...row.redirectUris], disabledAt: null });
    },
    async disable(clientId) {
      calls.push({ op: 'disable', clientId });
      const row = rows.get(clientId);
      if (!row || row.disabledAt !== null) return { disabled: false, familiesRevoked: 0 };
      row.disabledAt = new Date();
      return { disabled: true, familiesRevoked: 2 };
    },
  };
  return { store, rows, calls };
}

function depsFor(hosting: EnvClientHosting, fake = fakeStore()) {
  return {
    fake,
    deps: {
      loadEnv: async (envId: string) => (envId === ENV_ID ? { env, driveOwnerId: OWNER_ID } : null),
      loadHosting: async () => hosting,
      store: fake.store,
    },
  };
}

describe('syncEnvOAuthClient (idempotent upsert used by the env lifecycle)', () => {
  it('given the same env twice, leaves ONE row with the same content', async () => {
    const { deps, fake } = depsFor(previewOnly);
    const first = await syncEnvOAuthClient({ envId: ENV_ID, deps });
    const second = await syncEnvOAuthClient({ envId: ENV_ID, deps });
    expect(first).toEqual(second);
    expect(fake.rows.size).toBe(1);
    expect(fake.calls.filter((c) => c.op === 'upsert')).toHaveLength(2);
  });

  it('given a publish, adds the published redirect WITHOUT dropping the preview one', async () => {
    const fake = fakeStore();
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(previewOnly, fake).deps });
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(published, fake).deps });
    expect(fake.rows.get(`env_${ENV_ID}`)?.redirectUris).toEqual([PREVIEW_CB, PUBLISHED_CB]);
  });

  it('given an unpublish, removes only the published redirect', async () => {
    const fake = fakeStore();
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(published, fake).deps });
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(previewOnly, fake).deps });
    expect(fake.rows.get(`env_${ENV_ID}`)?.redirectUris).toEqual([PREVIEW_CB]);
  });

  it('given an env that no longer exists, writes nothing and says so', async () => {
    const { deps, fake } = depsFor(previewOnly);
    expect(await syncEnvOAuthClient({ envId: 'gone', deps })).toEqual({ ok: false, reason: 'env_not_found' });
    expect(fake.calls).toEqual([]);
  });
});

describe('retireEnvOAuthClient (env delete)', () => {
  it('disables the client and revokes every OAuth family for it, through the store', async () => {
    const fake = fakeStore();
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(previewOnly, fake).deps });
    const result = await retireEnvOAuthClient({ envId: ENV_ID, deps: { store: fake.store } });
    expect(result).toEqual({ clientId: `env_${ENV_ID}`, disabled: true, familiesRevoked: 2 });
    expect(fake.rows.get(`env_${ENV_ID}`)?.disabledAt).toBeInstanceOf(Date);
  });

  it('is idempotent: a second retire disables nothing and revokes nothing', async () => {
    const fake = fakeStore();
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(previewOnly, fake).deps });
    await retireEnvOAuthClient({ envId: ENV_ID, deps: { store: fake.store } });
    expect(await retireEnvOAuthClient({ envId: ENV_ID, deps: { store: fake.store } })).toEqual({ clientId: `env_${ENV_ID}`, disabled: false, familiesRevoked: 0 });
  });
});

describe('parseEnvOAuthClientId', () => {
  it('reads the env id out of env_<id> and refuses anything else (another client, a malformed id)', () => {
    expect(parseEnvOAuthClientId(`env_${ENV_ID}`)).toBe(ENV_ID);
    expect(parseEnvOAuthClientId('pagespace-cli')).toBeNull();
    expect(parseEnvOAuthClientId('app_abc')).toBeNull();
    expect(parseEnvOAuthClientId('env_')).toBeNull();
    expect(parseEnvOAuthClientId('env_NOT-A-LABEL')).toBeNull();
  });
});

describe('liveEnvRedirectUris — a stored redirect the env no longer derives grants nothing (PR #2711 ruling)', () => {
  const stale = 'https://old.example.com/auth/pagespace/callback';

  it('keeps only stored entries the current facts still derive, in stored order', () => {
    expect(liveEnvRedirectUris([PREVIEW_CB, stale, PUBLISHED_CB], [PUBLISHED_CB, PREVIEW_CB])).toEqual([PREVIEW_CB, PUBLISHED_CB]);
  });

  it('drops the published callback after an unpublish the sync never recorded, and a custom domain that lost serving status', () => {
    expect(liveEnvRedirectUris([PREVIEW_CB, PUBLISHED_CB, stale], envRedirectUris(ENV_ID, previewOnly))).toEqual([PREVIEW_CB]);
  });

  it('never ADDS a derived entry the row does not hold — additions are the sync\'s job', () => {
    expect(liveEnvRedirectUris([PREVIEW_CB], [PREVIEW_CB, PUBLISHED_CB])).toEqual([PREVIEW_CB]);
  });

  it('given no derivable facts at all, honours nothing', () => {
    expect(liveEnvRedirectUris([PREVIEW_CB, PUBLISHED_CB], [])).toEqual([]);
  });
});

describe('applyPendingRemoval — the facts as they will be once the removal lands', () => {
  it('unpublish drops the published half and keeps the preview apex', () => {
    expect(applyPendingRemoval(publishedWithDomains, { unpublish: true })).toEqual(previewOnly);
  });

  it('a hostname removal drops exactly that custom domain, case-insensitively, and nothing else', () => {
    const out = applyPendingRemoval(publishedWithDomains, { hostname: 'APP.example.com' });
    expect(out.published?.customDomains).toEqual(['shop.example.org']);
    expect(out.published?.subdomain).toBe('staging-4f2');
    expect(envRedirectUris(ENV_ID, out)).toEqual([PREVIEW_CB, PUBLISHED_CB, 'https://shop.example.org/auth/pagespace/callback']);
  });

  it('a hostname removal on an unpublished env is a no-op, and the input is never mutated', () => {
    const before = JSON.stringify(publishedWithDomains);
    expect(applyPendingRemoval(previewOnly, { hostname: 'app.example.com' })).toEqual(previewOnly);
    applyPendingRemoval(publishedWithDomains, { hostname: 'app.example.com' });
    expect(JSON.stringify(publishedWithDomains)).toBe(before);
  });
});

describe('syncEnvOAuthClient with a pending removal', () => {
  it('stores the REDUCED redirect set before the caller makes the removal durable', async () => {
    const fake = fakeStore();
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(publishedWithDomains, fake).deps, removal: { hostname: 'app.example.com' } });
    expect(fake.rows.get(`env_${ENV_ID}`)?.redirectUris).toEqual([PREVIEW_CB, PUBLISHED_CB, 'https://shop.example.org/auth/pagespace/callback']);
    await syncEnvOAuthClient({ envId: ENV_ID, deps: depsFor(publishedWithDomains, fake).deps, removal: { unpublish: true } });
    expect(fake.rows.get(`env_${ENV_ID}`)?.redirectUris).toEqual([PREVIEW_CB]);
  });

  it('propagates a store failure — a removal that did not land must not look like one that did', async () => {
    const failing = { ...fakeStore().store, upsert: async () => { throw new Error('db down'); } };
    const deps = { ...depsFor(publishedWithDomains).deps, store: failing };
    await expect(syncEnvOAuthClient({ envId: ENV_ID, deps, removal: { unpublish: true } })).rejects.toThrow('db down');
  });
});

