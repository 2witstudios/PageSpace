/**
 * The realtime tier's binding of the dev-preview access gather — the SAME
 * `resolvePreviewTarget` the web tier's HTTP proxy runs, wired to this
 * process's stores and Sprite SDK, so the WebSocket half of the proxy cannot
 * authorize differently from the HTTP half.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { canRunCode } from '@pagespace/lib/services/sandbox/can-run-code';
import { getSandboxSessionSecret } from '@pagespace/lib/services/sandbox/machine-session-manager';
import { resolveDriveMembership } from '@pagespace/lib/services/agent-workspaces/agent-workspace-tenant';
import { createDbAgentSessionStore } from '@pagespace/lib/services/agent-workspaces/agent-workspaces-store';
import { createDbDriveEnvStore } from '@pagespace/lib/services/drive-envs/drive-envs-store';
import { createSpritesSandboxClient, createSpriteHandleCache } from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { createSpriteSandboxHost } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-sandbox-host';
import type { SandboxHost } from '@pagespace/lib/services/sandbox/sandbox-host';
import { isDevPreviewEnabled } from '@pagespace/lib/services/sandbox/preview/dev-preview-env';
import { createDbDevPreviewStore, type DevPreviewStore } from '@pagespace/lib/services/sandbox/preview/dev-preview-store';
import type { PreviewAccessDeps } from '@pagespace/lib/services/sandbox/preview/preview-access';
import { derivePreviewCookieKey } from '@pagespace/lib/services/sandbox/preview/preview-grant';
import { getRealtimeSpritesSdk } from '../terminal/realtime-sprites-client';

let previewStore: DevPreviewStore | null = null;
export function getRealtimePreviewStore(): DevPreviewStore {
  previewStore ??= createDbDevPreviewStore();
  return previewStore;
}

/** One control-plane read per connect — the same per-connect cache the shell bridge applies. */
export async function createConnectScopedSandboxHost(): Promise<SandboxHost> {
  const sdk = createSpriteHandleCache(await getRealtimeSpritesSdk());
  return createSpriteSandboxHost({ sdk, client: createSpritesSandboxClient({ sdk }) });
}

export function getRealtimePreviewCookieKey(): Buffer {
  return derivePreviewCookieKey(getSandboxSessionSecret());
}

const sessionStorePromise = createDbAgentSessionStore();
const envStorePromise = createDbDriveEnvStore();

export function buildRealtimePreviewAccessDeps(): PreviewAccessDeps {
  return {
    findSession: async (workspaceId) => {
      const row = await (await sessionStorePromise).findById(workspaceId);
      if (!row) return null;
      const { id, ownerId, driveId, envId, sandboxId, spriteTornDownAt, endedAt } = row;
      return { id, ownerId, driveId, envId, sandboxId, spriteTornDownAt, endedAt };
    },
    findEnv: async (envId) => {
      const row = await (await envStorePromise).findById(envId);
      if (!row) return null;
      const { id, driveId, substrate, sandboxId, spriteTornDownAt } = row;
      return { id, driveId, substrate, sandboxId, spriteTornDownAt };
    },
    resolveDriveMembership,
    resolveDrivePayer: async (driveId) => {
      const [drive] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId)).limit(1);
      return drive ? { payerId: drive.ownerId } : null;
    },
    canRunCode: ({ userId, driveId, ownerId }) => canRunCode({ userId, driveId: driveId ?? undefined, ownerId, requestOrigin: 'user' }),
    attach: async (sandboxId) => (await createConnectScopedSandboxHost()).attach({ sandboxId }).catch(() => null),
    previewStore: getRealtimePreviewStore(),
    featureEnabled: isDevPreviewEnabled,
    now: () => new Date(),
  };
}
