import {
  createSpritesSandboxClient,
  resolveSpritesToken,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';
import type { ExecSandboxClient } from '@pagespace/lib/services/sandbox/sandbox-client/types';

let cachedSdk: SpritesSdk | null = null;

export async function getRealtimeSpritesSdk(): Promise<SpritesSdk> {
  if (cachedSdk) return cachedSdk;
  const { SpritesClient } = await import('@fly/sprites');
  const client = new SpritesClient(resolveSpritesToken());
  cachedSdk = {
    getSprite: (name) => client.getSprite(name) as unknown as Promise<SpriteInstanceLike>,
    createSprite: (name) => client.createSprite(name) as unknown as Promise<SpriteInstanceLike>,
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}

export async function getRealtimeSandboxClient(): Promise<ExecSandboxClient> {
  const sdk = await getRealtimeSpritesSdk();
  return createSpritesSandboxClient({ sdk });
}
