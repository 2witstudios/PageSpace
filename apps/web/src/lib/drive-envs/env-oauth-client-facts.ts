/**
 * The FACTS an environment's OAuth client is derived from, read from the
 * database — and the resolve-time answer to "which of this client's stored
 * redirects may be honoured right now".
 *
 * Kept apart from `env-oauth-client-runtime.ts` because `oauth-repository.ts`
 * (the provider's client resolution) needs the live-redirect answer, and the
 * runtime needs the repository's revoke path: one module on each side of that
 * edge, no cycle. Nothing here writes.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { customDomains } from '@pagespace/db/schema/custom-domains';
import { drives } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { publishedApps } from '@pagespace/db/schema/published-apps';
import { isServingStatus } from '@pagespace/lib/canvas/cert-action';
import { resolvePublishedAppsApex } from '@pagespace/lib/services/app-hosting/routing-env';
import {
  envRedirectUris,
  liveEnvRedirectUris,
  type EnvClientHosting,
  type EnvClientSource,
} from '@pagespace/lib/services/drive-envs/env-oauth-client';
import { isDevPreviewEnabled, resolveDevPreviewApex } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';

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

/**
 * The stored redirects of an env client that the env's CURRENT facts still
 * derive — evaluated when the client is resolved for an OAuth door, so a
 * custom domain that lost its proven-serving status, was deleted or detached,
 * or a published origin after unpublish, grants nothing even if the removal
 * sync that should have dropped it never landed (PR #2711 ruling). `null`
 * when the env no longer exists: a client whose env is gone resolves like an
 * unknown client.
 */
export async function resolveLiveEnvClientRedirectUris(envId: string, storedRedirectUris: readonly string[]): Promise<string[] | null> {
  const source = await loadEnvClientSource(envId);
  if (!source) return null;
  return liveEnvRedirectUris(storedRedirectUris, envRedirectUris(envId, await loadEnvClientHosting(envId)));
}
