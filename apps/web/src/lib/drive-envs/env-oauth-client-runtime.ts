/**
 * The platform-managed OAuth client of an environment — the WEB tier's I/O
 * half (ADR 0004 Decision 12; [D-9], [D-10]).
 *
 * Every decision lives in `@pagespace/lib/services/drive-envs/env-oauth-client`
 * (pure: `deriveEnvClient`) and its two lifecycle verbs over an injected
 * store. This module binds that store to `oauth_clients`, reads the facts the
 * derivation needs (the env, its drive's owner, the preview apex, the
 * `published_apps` row and the app's custom domains) and exposes the one call
 * every lifecycle hook makes: {@link syncEnvOAuthClientForEnv}. Env create,
 * rename, first preview open, publish, unpublish and a custom-domain change
 * all make the SAME call, because the row is a function of the facts, not of
 * the event. Env delete makes the other one, {@link retireEnvOAuthClientForEnv},
 * which disables the client and revokes every family it issued through the
 * Phase 1a revoke path (`revokeOAuthFamiliesForClient`).
 *
 * Idempotent by construction: the upsert is `ON CONFLICT (clientId) DO UPDATE`
 * over every derived column, so the same facts produce the same row however
 * many hooks fire.
 */

import { db } from '@pagespace/db/db';
import { and, eq, isNull } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { oauthClients } from '@pagespace/db/schema/oauth';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { isServingStatus } from '@pagespace/lib/canvas/cert-action';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolvePublishedAppsApex } from '@pagespace/lib/services/app-hosting/routing-env';
import {
  retireEnvOAuthClient,
  syncEnvOAuthClient,
  type EnvClientHosting,
  type EnvClientSource,
  type EnvOAuthClientStore,
  type SyncEnvOAuthClientResult,
} from '@pagespace/lib/services/drive-envs/env-oauth-client';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { revokeOAuthFamiliesForClient } from '@/lib/repositories/oauth-repository';

/** The `oauth_clients`-backed store. `now` is injected for the disable stamp and the revoke, like every other store here. */
export function createDbEnvOAuthClientStore(now: () => Date = () => new Date()): EnvOAuthClientStore {
  return {
    async upsert(row) {
      const stamp = now();
      await db
        .insert(oauthClients)
        .values({
          clientId: row.clientId,
          name: row.name,
          clientType: row.clientType,
          redirectUris: row.redirectUris,
          allowedGrantTypes: row.allowedGrantTypes,
          allowedScopes: row.allowedScopes,
          ownerUserId: row.ownerUserId,
          verified: row.verified,
          isFirstParty: row.isFirstParty,
        })
        .onConflictDoUpdate({
          target: oauthClients.clientId,
          set: {
            name: row.name,
            clientType: row.clientType,
            redirectUris: row.redirectUris,
            allowedGrantTypes: row.allowedGrantTypes,
            allowedScopes: row.allowedScopes,
            ownerUserId: row.ownerUserId,
            verified: row.verified,
            isFirstParty: row.isFirstParty,
            // A sync is only ever made for an env that EXISTS (the source read
            // returns null otherwise), so a row disabled by a retire is not
            // resurrected here for a deleted env — only an env that is back in
            // the lifecycle gets its client back.
            disabledAt: null,
            updatedAt: stamp,
          },
        });
    },
    async disable(clientId) {
      const stamp = now();
      // The stamp and the revoke are two statements, in this order, so a crash
      // between them leaves a client that refuses NEW grants (resolveClient
      // filters disabledAt) while the next retire — idempotent on the rows,
      // not on this branch — would find nothing to disable. The revoke is
      // therefore keyed on the ROW, not on whether this call stamped it.
      const [row] = await db
        .update(oauthClients)
        .set({ disabledAt: stamp })
        .where(and(eq(oauthClients.clientId, clientId), isNull(oauthClients.disabledAt)))
        .returning({ id: oauthClients.id });
      const existing = row ?? (await db.query.oauthClients.findFirst({ where: eq(oauthClients.clientId, clientId), columns: { id: true } })) ?? null;
      if (!existing) return { disabled: false, familiesRevoked: 0 };
      const familiesRevoked = await revokeOAuthFamiliesForClient({ clientDbId: existing.id, now: stamp });
      return { disabled: row !== undefined, familiesRevoked };
    },
  };
}

/** The env and its drive's OWNER — the client's owner, like every other bill for the env. Null when either is gone. */
export async function loadEnvClientSource(envId: string): Promise<EnvClientSource | null> {
  const [row] = await db
    .select({ id: driveEnvs.id, name: driveEnvs.name, driveOwnerId: drives.ownerId })
    .from(driveEnvs)
    .innerJoin(drives, eq(drives.id, driveEnvs.driveId))
    .where(eq(driveEnvs.id, envId))
    .limit(1);
  return row ? { env: { id: row.id, name: row.name }, driveOwnerId: row.driveOwnerId } : null;
}

/**
 * Where the env's app is reachable: the preview apex (only while the preview
 * feature is on — a host the proxy refuses is not a redirect), the published
 * subdomain, and every custom domain pointed at the app whose DNS ownership
 * is proven (`isServingStatus`: verified, provisioning or active).
 */
export async function loadEnvClientHosting(envId: string): Promise<EnvClientHosting> {
  const previewApex = isDevPreviewEnabled() ? resolveDevPreviewApex() : null;
  const [app] = await db
    .select({ id: publishedApps.id, subdomain: publishedApps.subdomain })
    .from(publishedApps)
    .where(eq(publishedApps.envId, envId))
    .limit(1);
  if (!app) return { previewApex, published: null };
  const domains = await db
    .select({ hostname: customDomains.hostname, status: customDomains.status })
    .from(customDomains)
    .where(eq(customDomains.publishedAppId, app.id));
  return {
    previewApex,
    published: {
      subdomain: app.subdomain,
      apex: resolvePublishedAppsApex(),
      customDomains: domains.filter((d) => isServingStatus(d.status)).map((d) => d.hostname),
    },
  };
}

/** Bring the env's client row up to date with the env's current facts. Throws on a database failure; see the best-effort wrapper. */
export function syncEnvOAuthClientForEnv(envId: string): Promise<SyncEnvOAuthClientResult> {
  return syncEnvOAuthClient({
    envId,
    deps: { loadEnv: loadEnvClientSource, loadHosting: loadEnvClientHosting, store: createDbEnvOAuthClientStore() },
  });
}

/** The same, addressed by the hosting row (custom-domain hooks know the app, not the env). No-op for an unknown app. */
export async function syncEnvOAuthClientForPublishedApp(publishedAppId: string): Promise<SyncEnvOAuthClientResult | null> {
  const [app] = await db.select({ envId: publishedApps.envId }).from(publishedApps).where(eq(publishedApps.id, publishedAppId)).limit(1);
  return app ? syncEnvOAuthClientForEnv(app.envId) : null;
}

/** The same, addressed by a custom domain (the cert reconciler knows the domain, not the app). No-op for a domain that points at no app. */
export async function syncEnvOAuthClientForCustomDomain(customDomainId: string): Promise<SyncEnvOAuthClientResult | null> {
  const [domain] = await db.select({ publishedAppId: customDomains.publishedAppId }).from(customDomains).where(eq(customDomains.id, customDomainId)).limit(1);
  return domain?.publishedAppId ? syncEnvOAuthClientForPublishedApp(domain.publishedAppId) : null;
}

/** What a lifecycle hook addresses: the env itself, its hosting row, or a custom domain pointed at that row. */
export type EnvOAuthClientSyncTarget = { envId: string } | { publishedAppId: string } | { customDomainId: string };

/**
 * The hook shape: never fails the operation it rides on. An env whose client
 * could not be written still exists; the next lifecycle event (first preview,
 * publish) re-syncs it, and the failure is logged where an operator looks.
 */
export async function syncEnvOAuthClientBestEffort(target: EnvOAuthClientSyncTarget, context: Record<string, unknown>): Promise<void> {
  try {
    const result =
      'envId' in target
        ? await syncEnvOAuthClientForEnv(target.envId)
        : 'publishedAppId' in target
          ? await syncEnvOAuthClientForPublishedApp(target.publishedAppId)
          : await syncEnvOAuthClientForCustomDomain(target.customDomainId);
    if (result && !result.ok) {
      loggers.api.warn('env OAuth client sync skipped', { ...context, ...target, reason: result.reason });
    }
  } catch (error) {
    loggers.api.error('env OAuth client sync failed', error instanceof Error ? error : new Error(String(error)), { ...context, ...target });
  }
}

/** Env delete: disable `env_<envId>` and revoke everything it issued. The env row may already be gone. */
export function retireEnvOAuthClientForEnv(envId: string): Promise<{ clientId: string; disabled: boolean; familiesRevoked: number }> {
  return retireEnvOAuthClient({ envId, deps: { store: createDbEnvOAuthClientStore() } });
}

/** The hook shape for delete. Logged at error level: a client that outlives its env is a real, if bounded, exposure. */
export async function retireEnvOAuthClientBestEffort(envId: string, context: Record<string, unknown>): Promise<{ clientId: string; disabled: boolean; familiesRevoked: number } | null> {
  try {
    return await retireEnvOAuthClientForEnv(envId);
  } catch (error) {
    loggers.api.error('env OAuth client retire failed', error instanceof Error ? error : new Error(String(error)), { ...context, envId });
    return null;
  }
}
