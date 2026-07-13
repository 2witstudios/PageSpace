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

import { SpritesClient, type Sprite } from '@fly/sprites';
import {
  createSpritesSandboxClient,
  killSpriteSession,
  resolveSpritesToken,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import { createSpriteMachineHost } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-machine-host';
import { createExecClientFromMachineHost } from '@pagespace/lib/services/sandbox/sandbox-client/machine-host-adapter';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';
import type { MachineHost } from '@pagespace/lib/services/sandbox/machine-host';

let cachedSdk: SpritesSdk | null = null;

/** The raw Sprites SDK — for callers that need to reach a Sprite directly (e.g. to wake a resumed one) rather than through an `ExecSandboxClient`/`MachineHost` adapter. */
export async function getProductionSpritesSdk(): Promise<SpritesSdk> {
  return getSpritesSDK();
}

/**
 * Bolt `killSession` onto a raw SDK `Sprite` instance — `@fly/sprites` (rc37)
 * exposes no session-kill-by-id, only `attachSession`/`createSession`/`kill()`
 * (a per-command WebSocket signal); see `killSpriteSession`'s doc for why this
 * hits the REST endpoint directly. `baseURL`/`token` are public `readonly`
 * fields on `SpritesClient`, reachable straight off `sprite.client`.
 */
function withKillSession(sprite: Sprite): SpriteInstanceLike {
  return Object.assign(sprite, {
    killSession: (sessionId: string) =>
      killSpriteSession({ baseURL: sprite.client.baseURL, token: sprite.client.token }, sprite.name, sessionId),
  }) as unknown as SpriteInstanceLike;
}

async function getSpritesSDK(): Promise<SpritesSdk> {
  if (cachedSdk) return cachedSdk;
  const client = new SpritesClient(resolveSpritesToken());
  cachedSdk = {
    getSprite: async (name) => withKillSession(await client.getSprite(name)),
    createSprite: async (name, config) => withKillSession(await client.createSprite(name, config)),
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}

export async function createProductionSpritesSandboxClient(): Promise<ExecSandboxClient> {
  const host = await createProductionMachineHost();
  return createExecClientFromMachineHost(host, { kind: 'sprite' });
}

/**
 * The raw `MachineHost` (not re-adapted back to `ExecSandboxClient`), for
 * callers that provision/attach/kill Sprites directly rather than through a
 * page-keyed persistent session — e.g. the Branches tier
 * (`services/machines/machine-branches.ts`), where each branch-terminal is
 * its OWN Sprite, addressed by its own derived session key.
 */
export async function createProductionMachineHost(): Promise<MachineHost> {
  const sdk = await getSpritesSDK();
  const client = createSpritesSandboxClient({ sdk });
  return createSpriteMachineHost({ sdk, client });
}
