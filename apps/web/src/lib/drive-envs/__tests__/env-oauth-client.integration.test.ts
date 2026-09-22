/**
 * US6 end to end, against a REAL Postgres — "Sign in with PageSpace" Phase 4
 * (epic yv08hib74nrtmksdzxmf5nkw; ADR 0004 Decision 12; [D-9], [D-10]).
 *
 * The whole shape, in the order a builder meets it: create an env → its
 * platform-managed client row exists → the SANDBOX env map carries the two
 * public values → the SDK's own `resolveEnvironmentConfig` turns them plus the
 * preview origin into the preview callback → the REAL authorize-time redirect
 * check (`validateRedirectUri` over `registeredClientFromRecord` of the stored
 * row) honours it → publish → re-sync → the published callback is honoured
 * WITHOUT the preview one disappearing → a custom domain joins and leaves →
 * unpublish drops only the published redirect → env delete disables the
 * client and revokes every family it issued, through the Phase 1a revoke
 * path. No secret in either env map, checked by shape.
 *
 * Requires DATABASE_URL → a migrated Postgres; FAILS LOUDLY when unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, isNull } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { oauthAccessTokens, oauthClients, oauthRefreshTokens } from '@pagespace/db/schema/oauth';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { factories } from '@pagespace/db/test/factories';
import { registeredClientFromRecord, validateRedirectUri } from '@pagespace/lib/auth/oauth/clients';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { buildMachineConfig } from '@pagespace/lib/services/app-hosting/build-core';
import { ENV_OAUTH_CALLBACK_PATH, envOAuthClientId, syncEnvOAuthClient } from '@pagespace/lib/services/drive-envs/env-oauth-client';
import { buildSandboxEnv, findSecretShapedEnvEntries } from '@pagespace/lib/services/sandbox/sandbox-env';
import { PAGESPACE_CALLBACK_PATH, resolveEnvironmentConfig } from '@pagespace/sdk';
import { ensureTestDb } from '@/test/ensure-test-db';
import { resolveClient } from '@/lib/repositories/oauth-repository';
import { retireEnvOAuthClientForEnv, syncEnvOAuthClientForEnv, syncEnvOAuthClientForPublishedApp, syncEnvOAuthClientForRemoval } from '../env-oauth-client-runtime';
import { loadEnvClientHosting, loadEnvClientSource } from '../env-oauth-client-facts';

const PREVIEW_APEX = 'pagespace-preview.app';
const PUBLISHED_APEX = 'pagespace.io';
const PAGESPACE_URL = 'https://app.pagespace.ai';
const ENV_KEYS = ['DEV_PREVIEW_ENABLED', 'DEV_PREVIEW_APEX', 'PUBLISHED_APPS_APEX', 'WEB_APP_URL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

async function clientRow(clientId: string) {
  return db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId) });
}

async function clientRowCount(clientId: string): Promise<number> {
  return (await db.select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.clientId, clientId))).length;
}

/**
 * The REAL authorize-time check: `resolveClient` is what `/api/oauth/authorize`
 * calls (static registry, then the enabled row — with an env client's redirects
 * filtered to what its env still derives), and `validateRedirectUri` is the
 * redirect rule it applies. Would authorize honour this redirect for this client?
 */
async function authorizeWouldHonour(clientId: string, redirectUri: string): Promise<boolean> {
  const client = await resolveClient(clientId);
  return client !== null && validateRedirectUri(client, redirectUri);
}

/** The same check over the RAW stored row — what the answer would be WITHOUT the resolve-time filter (the stale-entry control). */
async function storedRowWouldHonour(clientId: string, redirectUri: string): Promise<boolean> {
  const row = await clientRow(clientId);
  if (!row) return false;
  const client = registeredClientFromRecord(row);
  return client !== null && validateRedirectUri(client, redirectUri);
}

describe('US6: sign-in works in an environment and, unchanged, after publish', () => {
  let ownerId: string;
  let driveId: string;
  let envId: string;
  let clientId: string;

  beforeAll(async () => {
    await ensureTestDb();
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.DEV_PREVIEW_ENABLED = 'true';
    process.env.DEV_PREVIEW_APEX = PREVIEW_APEX;
    process.env.PUBLISHED_APPS_APEX = PUBLISHED_APEX;
    process.env.WEB_APP_URL = PAGESPACE_URL;

    const owner = await factories.createUser();
    ownerId = owner.id;
    driveId = (await factories.createDrive(ownerId)).id;
    const [env] = await db.insert(driveEnvs).values({ id: createId(), driveId, name: 'staging', createdBy: ownerId }).returning();
    envId = env.id;
    clientId = envOAuthClientId(envId);
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('the callback path the platform registers is the one the SDK appends ([D-10]) — pinned across the package boundary', () => {
    expect(ENV_OAUTH_CALLBACK_PATH).toBe(PAGESPACE_CALLBACK_PATH);
  });

  it('env create → derive + upsert: one verified, non-first-party, scope-capped client row; a second upsert leaves the same one row', async () => {
    const first = await syncEnvOAuthClientForEnv(envId);
    expect(first.ok).toBe(true);
    const second = await syncEnvOAuthClientForEnv(envId);
    expect(second).toEqual(first);
    expect(await clientRowCount(clientId)).toBe(1);

    const row = await clientRow(clientId);
    expect(row).toMatchObject({
      clientId,
      name: 'staging',
      clientType: 'public',
      verified: true,
      isFirstParty: false,
      ownerUserId: ownerId,
      allowedGrantTypes: ['authorization_code', 'refresh_token'],
      allowedScopes: ['profile', 'offline_access', 'drive', 'drive:admin', 'drive:member', 'drive:role'],
      disabledAt: null,
      redirectUris: [`https://env-${envId}.preview.${PREVIEW_APEX}${PAGESPACE_CALLBACK_PATH}`],
    });

    // The provider's own resolution (static registry first, then the row) sees it — as a third party, never first-party.
    const resolved = await resolveClient(clientId);
    expect(resolved).toMatchObject({ clientId, firstParty: false, verified: true, type: 'public' });
  });

  it('the sandbox env map → PageSpaceClient.fromEnvironment on the PREVIEW origin → the preview callback, which authorize honours; no secret in the map', async () => {
    const sandboxEnv = buildSandboxEnv({ env: { WEB_APP_URL: PAGESPACE_URL }, signIn: { envId } });
    expect(sandboxEnv.PAGESPACE_URL).toBe(PAGESPACE_URL);
    expect(sandboxEnv.PAGESPACE_CLIENT_ID).toBe(clientId);
    expect(findSecretShapedEnvEntries(sandboxEnv)).toEqual([]);

    const previewOrigin = `https://env-${envId}.preview.${PREVIEW_APEX}`;
    const config = resolveEnvironmentConfig(sandboxEnv, previewOrigin);
    expect(config).toEqual({ baseUrl: PAGESPACE_URL, clientId, redirectUri: `${previewOrigin}${PAGESPACE_CALLBACK_PATH}` });
    expect(await authorizeWouldHonour(clientId, config.redirectUri)).toBe(true);

    // A redirect the platform did not register is refused by the same check — the assertion above is not vacuous.
    expect(await authorizeWouldHonour(clientId, `https://evil.example${PAGESPACE_CALLBACK_PATH}`)).toBe(false);
    expect(await authorizeWouldHonour(clientId, `${previewOrigin}/other`)).toBe(false);
  });

  it('publish → re-upsert: the published origin is honoured AND the preview one still is; the machine env map carries the same two values and no secret', async () => {
    const subdomain = `staging-${createId().slice(0, 6)}`;
    const [app] = await db
      .insert(publishedApps)
      .values({ envId, driveId, ownerId, flyAppName: `pgs-app-${createId()}`, networkName: 'published-apps', subdomain, status: 'building' })
      .returning();

    const synced = await syncEnvOAuthClientForEnv(envId);
    expect(synced.ok).toBe(true);
    expect(await clientRowCount(clientId)).toBe(1);

    const previewOrigin = `https://env-${envId}.preview.${PREVIEW_APEX}`;
    const publishedOrigin = `https://${subdomain}.${PUBLISHED_APEX}`;
    const row = await clientRow(clientId);
    expect(row?.redirectUris).toEqual([`${previewOrigin}${PAGESPACE_CALLBACK_PATH}`, `${publishedOrigin}${PAGESPACE_CALLBACK_PATH}`]);

    const machine = buildMachineConfig({
      flyAppName: app.flyAppName,
      digest: 'sha256:' + 'a'.repeat(64),
      guestPreset: app.guestPreset,
      publishedAppId: app.id,
      tier: app.tier,
      signIn: { envId: app.envId, pagespaceUrl: PAGESPACE_URL },
    });
    const machineEnv = machine?.env ?? { LEAK_IF_NULL: 'ps_at_x' };
    expect(machineEnv).toMatchObject({ PAGESPACE_URL, PAGESPACE_CLIENT_ID: clientId });
    expect(findSecretShapedEnvEntries(machineEnv)).toEqual([]);

    // The SAME app code, now served from the published origin, resolves the published callback — and authorize honours it.
    const published = resolveEnvironmentConfig(machineEnv, publishedOrigin);
    expect(published.redirectUri).toBe(`${publishedOrigin}${PAGESPACE_CALLBACK_PATH}`);
    expect(await authorizeWouldHonour(clientId, published.redirectUri)).toBe(true);
    // …WITHOUT the preview one disappearing.
    expect(await authorizeWouldHonour(clientId, `${previewOrigin}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
  });

  it('a custom domain with proven DNS ownership joins the redirect set; a pending one does not; detaching it removes it', async () => {
    const app = await db.query.publishedApps.findFirst({ where: eq(publishedApps.envId, envId) });
    expect(app).toBeTruthy();
    const active = `app-${createId().slice(0, 6)}.example.test`;
    const pending = `soon-${createId().slice(0, 6)}.example.test`;
    await db.insert(customDomains).values([
      { driveId, hostname: active, status: 'active', publishedAppId: app!.id },
      { driveId, hostname: pending, status: 'pending', publishedAppId: app!.id },
    ]);

    expect((await syncEnvOAuthClientForPublishedApp(app!.id))?.ok).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://${active}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://${pending}${PAGESPACE_CALLBACK_PATH}`)).toBe(false);

    await db.update(customDomains).set({ publishedAppId: null }).where(eq(customDomains.hostname, active));
    expect((await syncEnvOAuthClientForPublishedApp(app!.id))?.ok).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://${active}${PAGESPACE_CALLBACK_PATH}`)).toBe(false);
  });

  // --- PR #2711 ruling: a dropped REMOVAL must grant nothing at authorize time ---
  // Each case changes the database the way the removal path would, WITHOUT the
  // sync that should have followed (the dropped-removal scenario), then asks
  // the provider's own `resolveClient` — what /api/oauth/authorize calls — and
  // the real `validateRedirectUri` over it. The stale entry is still in the
  // row; it is simply not honoured. Same shape as any other refusal.

  it('serving status lost + the removal sync dropped: authorize refuses the hostname, while the still-serving entries are honoured', async () => {
    const app = await db.query.publishedApps.findFirst({ where: eq(publishedApps.envId, envId) });
    const lost = `lost-${createId().slice(0, 6)}.example.test`;
    await db.insert(customDomains).values({ driveId, hostname: lost, status: 'active', publishedAppId: app!.id });
    expect((await syncEnvOAuthClientForPublishedApp(app!.id))?.ok).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://${lost}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);

    // The cert reconciler flips the status; the sync that should have followed never runs.
    await db.update(customDomains).set({ status: 'cert_failed' }).where(eq(customDomains.hostname, lost));
    expect(await storedRowWouldHonour(clientId, `https://${lost}${PAGESPACE_CALLBACK_PATH}`)).toBe(true); // stale in the row — the raw row alone would still honour it
    expect(await authorizeWouldHonour(clientId, `https://${lost}${PAGESPACE_CALLBACK_PATH}`)).toBe(false); // the provider refuses it anyway
    expect(await authorizeWouldHonour(clientId, `https://${app!.subdomain}.${PUBLISHED_APEX}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://env-${envId}.preview.${PREVIEW_APEX}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    await db.delete(customDomains).where(eq(customDomains.hostname, lost));
  });

  it('domain deleted + the removal sync dropped: authorize refuses the hostname', async () => {
    const app = await db.query.publishedApps.findFirst({ where: eq(publishedApps.envId, envId) });
    const gone = `gone-${createId().slice(0, 6)}.example.test`;
    await db.insert(customDomains).values({ driveId, hostname: gone, status: 'active', publishedAppId: app!.id });
    expect((await syncEnvOAuthClientForPublishedApp(app!.id))?.ok).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://${gone}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);

    await db.delete(customDomains).where(eq(customDomains.hostname, gone));
    expect(await storedRowWouldHonour(clientId, `https://${gone}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    expect(await authorizeWouldHonour(clientId, `https://${gone}${PAGESPACE_CALLBACK_PATH}`)).toBe(false);
  });

  it('the removal path itself writes the reduced set BEFORE the destructive step, and a store failure throws', async () => {
    const app = await db.query.publishedApps.findFirst({ where: eq(publishedApps.envId, envId) });
    const leaving = `leaving-${createId().slice(0, 6)}.example.test`;
    await db.insert(customDomains).values({ driveId, hostname: leaving, status: 'active', publishedAppId: app!.id });
    expect((await syncEnvOAuthClientForPublishedApp(app!.id))?.ok).toBe(true);
    expect((await clientRow(clientId))?.redirectUris).toContain(`https://${leaving}${PAGESPACE_CALLBACK_PATH}`);

    // The domain row still exists (the delete has not happened yet) — the removal is written first.
    const removed = await syncEnvOAuthClientForRemoval({ publishedAppId: app!.id }, { hostname: leaving });
    expect(removed?.ok).toBe(true);
    expect((await clientRow(clientId))?.redirectUris).not.toContain(`https://${leaving}${PAGESPACE_CALLBACK_PATH}`);
    await db.delete(customDomains).where(eq(customDomains.hostname, leaving));

    // The lib verb propagates a store failure — nothing swallows it on the removal path.
    await expect(
      syncEnvOAuthClient({
        envId,
        removal: { unpublish: true },
        deps: { loadEnv: loadEnvClientSource, loadHosting: loadEnvClientHosting, store: { upsert: async () => { throw new Error('db down'); } } },
      }),
    ).rejects.toThrow('db down');
  });

  it('unpublished + the removal sync dropped: authorize refuses the published origin, the preview stays honoured', async () => {
    const app = await db.query.publishedApps.findFirst({ where: eq(publishedApps.envId, envId) });
    const publishedOrigin = `https://${app!.subdomain}.${PUBLISHED_APEX}`;
    expect(await authorizeWouldHonour(clientId, `${publishedOrigin}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    await db.delete(publishedApps).where(eq(publishedApps.id, app!.id)); // no sync follows
    expect(await storedRowWouldHonour(clientId, `${publishedOrigin}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    expect(await authorizeWouldHonour(clientId, `${publishedOrigin}${PAGESPACE_CALLBACK_PATH}`)).toBe(false);
    expect(await authorizeWouldHonour(clientId, `https://env-${envId}.preview.${PREVIEW_APEX}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
    // The provider still resolves the client (the env exists) — only the redirect is refused.
    expect(await resolveClient(clientId)).toMatchObject({ clientId, redirectUris: [`https://env-${envId}.preview.${PREVIEW_APEX}${PAGESPACE_CALLBACK_PATH}`] });
    // Put the hosting row back for the unpublish test below.
    await db.insert(publishedApps).values({ id: app!.id, envId, driveId, ownerId, flyAppName: app!.flyAppName, networkName: 'published-apps', subdomain: app!.subdomain, status: 'building' });
  });

  it('unpublish → re-upsert removes only the published redirect', async () => {
    const app = await db.query.publishedApps.findFirst({ where: eq(publishedApps.envId, envId) });
    const publishedOrigin = `https://${app!.subdomain}.${PUBLISHED_APEX}`;
    await db.delete(publishedApps).where(eq(publishedApps.id, app!.id));

    expect((await syncEnvOAuthClientForEnv(envId)).ok).toBe(true);
    const previewOrigin = `https://env-${envId}.preview.${PREVIEW_APEX}`;
    expect((await clientRow(clientId))?.redirectUris).toEqual([`${previewOrigin}${PAGESPACE_CALLBACK_PATH}`]);
    expect(await authorizeWouldHonour(clientId, `${publishedOrigin}${PAGESPACE_CALLBACK_PATH}`)).toBe(false);
    expect(await authorizeWouldHonour(clientId, `${previewOrigin}${PAGESPACE_CALLBACK_PATH}`)).toBe(true);
  });

  it('env delete → the client is disabled and EVERY family it issued is revoked (refresh and access), and the provider no longer resolves it', async () => {
    const row = await clientRow(clientId);
    const familyId = createId();
    const refresh = generateToken('ps_rt');
    const access = generateToken('ps_at');
    const unrelatedFamily = createId();
    const unrelatedClient = await db
      .insert(oauthClients)
      .values({ clientId: `app_${createId()}`, name: 'Bystander', clientType: 'public', redirectUris: ['https://bystander.example/cb'], allowedGrantTypes: ['authorization_code'], allowedScopes: ['profile'], ownerUserId: ownerId })
      .returning();
    const bystander = generateToken('ps_at');
    const soon = new Date(Date.now() + 15 * 60 * 1000);
    await db.insert(oauthRefreshTokens).values({ tokenHash: refresh.hash, tokenPrefix: refresh.tokenPrefix, familyId, clientId: row!.id, userId: ownerId, scopes: ['profile'], tokenVersion: 0, expiresAt: soon, familyExpiresAt: soon });
    await db.insert(oauthAccessTokens).values([
      { tokenHash: access.hash, tokenPrefix: access.tokenPrefix, familyId, clientId: row!.id, userId: ownerId, scopes: ['profile'], tokenVersion: 0, expiresAt: soon },
      { tokenHash: bystander.hash, tokenPrefix: bystander.tokenPrefix, familyId: unrelatedFamily, clientId: unrelatedClient[0].id, userId: ownerId, scopes: ['profile'], tokenVersion: 0, expiresAt: soon },
    ]);

    // The env row goes first (the real delete path: row, then retire); the client id is derivable without it.
    await db.delete(driveEnvs).where(eq(driveEnvs.id, envId));
    const retired = await retireEnvOAuthClientForEnv(envId);
    expect(retired).toEqual({ clientId, disabled: true, familiesRevoked: 1 });

    const after = await clientRow(clientId);
    expect(after?.disabledAt).toBeInstanceOf(Date);
    expect(await resolveClient(clientId)).toBeNull();

    const liveRefresh = await db.select({ id: oauthRefreshTokens.id }).from(oauthRefreshTokens).where(and(eq(oauthRefreshTokens.familyId, familyId), isNull(oauthRefreshTokens.revokedAt)));
    const liveAccess = await db.select({ id: oauthAccessTokens.id }).from(oauthAccessTokens).where(and(eq(oauthAccessTokens.familyId, familyId), isNull(oauthAccessTokens.revokedAt)));
    expect(liveRefresh).toEqual([]);
    expect(liveAccess).toEqual([]);
    const revokedAccess = await db.query.oauthAccessTokens.findFirst({ where: eq(oauthAccessTokens.tokenHash, access.hash) });
    expect(revokedAccess?.revokedReason).toBe('client_disabled');
    // Another client's family is untouched — the revoke is keyed on THIS client's rows.
    const bystanderRow = await db.query.oauthAccessTokens.findFirst({ where: eq(oauthAccessTokens.tokenHash, bystander.hash) });
    expect(bystanderRow?.revokedAt).toBeNull();

    // Env gone + the retire dropped: even an ENABLED row for a deleted env does not resolve (same as an unknown client).
    await db.update(oauthClients).set({ disabledAt: null }).where(eq(oauthClients.clientId, clientId));
    expect(await resolveClient(clientId)).toBeNull();
    await db.update(oauthClients).set({ disabledAt: new Date() }).where(eq(oauthClients.clientId, clientId));

    // Idempotent: a second retire disables nothing and revokes nothing.
    expect(await retireEnvOAuthClientForEnv(envId)).toEqual({ clientId, disabled: false, familiesRevoked: 0 });
    // And a sync for the deleted env writes nothing — a retired client is not resurrected.
    expect(await syncEnvOAuthClientForEnv(envId)).toEqual({ ok: false, reason: 'env_not_found' });
    expect((await clientRow(clientId))?.disabledAt).toBeInstanceOf(Date);
  });
});
