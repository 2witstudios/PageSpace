/**
 * App-boundary factory for the Fly Sprites sandbox client.
 *
 * @fly/sprites is ESM-only. @pagespace/lib compiles to CommonJS, so a static
 * import there becomes `require('@fly/sprites')` in the dist — which Node.js
 * rejects with ERR_REQUIRE_ESM. This file lives in apps/web where @fly/sprites
 * is a direct dependency, so webpack can bundle it as a server async chunk.
 * The dynamic import() below is what triggers that async bundling path instead
 * of a synchronous CJS require() — the only form that works for an ESM-only
 * package.
 *
 * The SpritesClient instance is created lazily and cached for the process
 * lifetime so the SDK is never touched on the code-execution-OFF path.
 */

import {
  createSpritesSandboxClient,
  resolveSpritesToken,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';

let cachedSdk: SpritesSdk | null = null;

async function getSpritesSDK(): Promise<SpritesSdk> {
  if (cachedSdk) return cachedSdk;
  // Dynamic import: @fly/sprites is a direct dep of apps/web (NOT listed in
  // serverExternalPackages), so webpack bundles it as a server async chunk.
  // The dynamic import() here is what triggers that async bundling path rather
  // than a CJS require() — the only form that works for an ESM-only package.
  const { SpritesClient } = await import('@fly/sprites');
  const client = new SpritesClient(resolveSpritesToken());
  cachedSdk = {
    getSprite: (name) => client.getSprite(name) as unknown as Promise<SpriteInstanceLike>,
    createSprite: (name, config) =>
      client.createSprite(name, config) as unknown as Promise<SpriteInstanceLike>,
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}

export async function createProductionSpritesSandboxClient(): Promise<ExecSandboxClient> {
  const sdk = await getSpritesSDK();
  return createSpritesSandboxClient({ sdk });
}
