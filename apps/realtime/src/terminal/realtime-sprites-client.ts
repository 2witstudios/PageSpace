import {
  resolveSpritesToken,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

let cachedSdk: SpritesSdk | null = null;

export async function getRealtimeSpritesSdk(): Promise<SpritesSdk> {
  if (cachedSdk) return cachedSdk;
  // @fly/sprites is ESM-only. TS 5.8 with module:commonjs preserves dynamic import()
  // as-is (does not lower to require()), so Node 22.17.0 in production handles it natively.
  const { SpritesClient } = await import('@fly/sprites');
  const client = new SpritesClient(resolveSpritesToken());
  cachedSdk = {
    getSprite: (name) => client.getSprite(name) as unknown as Promise<SpriteInstanceLike>,
    createSprite: (name) => client.createSprite(name) as unknown as Promise<SpriteInstanceLike>,
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}
