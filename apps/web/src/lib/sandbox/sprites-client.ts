/**
 * App-boundary factory for the Fly Sprites sandbox client.
 *
 * @fly/sprites is ESM-only. @pagespace/lib compiles to CommonJS, so a static
 * import there becomes `require('@fly/sprites')` in the dist — which Node.js
 * rejects with ERR_REQUIRE_ESM. This file lives in apps/web where @fly/sprites
 * is a direct dependency and Next can bundle the ESM SDK from the server graph.
 *
 * The SpritesClient instance is created lazily and cached for the process
 * lifetime so the SDK is never touched on the code-execution-OFF path.
 */

import { SpritesClient } from '@fly/sprites';
import {
  createSpritesSandboxClient,
  createSpriteHandleCache,
  withKillSession,
  resolveSpritesToken,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { createSpriteSandboxHost } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-sandbox-host';
import { createExecClientFromSandboxHost } from '@pagespace/lib/services/sandbox/sandbox-client/sandbox-host-adapter';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import type { SandboxHost } from '@pagespace/lib/services/sandbox/sandbox-host';

let cachedSdk: SpritesSdk | null = null;

async function getSpritesSDK(): Promise<SpritesSdk> {
  if (cachedSdk) return cachedSdk;
  const client = new SpritesClient(resolveSpritesToken());
  cachedSdk = {
    // withKillSession bolts the REST kill-session method onto the raw SDK
    // instance — see its doc (sprites.ts) for why the SDK needs this at all.
    getSprite: async (name) => withKillSession(await client.getSprite(name)) as unknown as SpriteInstanceLike,
    createSprite: async (name, config) => withKillSession(await client.createSprite(name, config)) as unknown as SpriteInstanceLike,
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}

export async function createProductionSpritesSandboxClient(): Promise<ExecSandboxClient> {
  const host = await createProductionSandboxHost();
  return createExecClientFromSandboxHost(host, { kind: 'sprite' });
}

/**
 * The raw `SandboxHost` (not re-adapted back to `ExecSandboxClient`), for
 * callers that provision/attach/kill Sprites directly rather than through a
 * page-keyed persistent session — e.g. the Branches tier
 * (`services/machines/machine-branches.ts`), where each branch-terminal is
 * its OWN Sprite, addressed by its own derived session key.
 */
export async function createProductionSandboxHost(): Promise<SandboxHost> {
  const sdk = await getSpritesSDK();
  const client = createSpritesSandboxClient({ sdk });
  return createSpriteSandboxHost({ sdk, client });
}

/**
 * A `SandboxHost` whose control-plane reads are collapsed for ONE request.
 *
 * `createSpriteSandboxHost`'s per-call methods (`services.get`, `urlInfo`,
 * `powerState`, `attach`) each do their own `getSprite`, and the dev-preview
 * proxy asks all four on every request — four control-plane round trips
 * where one will do. Wrapping the SDK in `createSpriteHandleCache` (the same
 * cache the realtime tier applies per connect) makes them one. Request-scoped
 * ON PURPOSE: the cache never expires, so a process-wide one would hand every
 * later request a sprite handle frozen at first sight (stale `status`, stale
 * `url`). Build one per request, drop it with the request.
 */
export async function createRequestScopedSandboxHost(): Promise<SandboxHost> {
  const sdk = createSpriteHandleCache(await getSpritesSDK());
  const client = createSpritesSandboxClient({ sdk });
  return createSpriteSandboxHost({ sdk, client });
}
