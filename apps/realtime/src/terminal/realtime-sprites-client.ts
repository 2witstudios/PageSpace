import {
  resolveSpritesToken,
  type SpritesSdk,
  type SpriteInstanceLike,
} from '@pagespace/lib/services/sandbox/sandbox-client/sprites';

let cachedSdk: SpritesSdk | null = null;

// The @fly/sprites SDK is Node >= 24 / ESM-only: it drives exec over the global
// WebSocket with a `{ headers }` option that older Node's WebSocket ignores, so
// on Node < 24 the terminal connect hangs/fails confusingly instead of working.
// Mirror apps/web's assertSandboxRuntime so the realtime path fails loudly with
// an actionable message instead of silently hanging "Connecting to shell…".
const MIN_SANDBOX_NODE_MAJOR = 24;

function assertSandboxRuntime(): void {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < MIN_SANDBOX_NODE_MAJOR) {
    throw new Error(
      `Terminal sandbox requires Node.js >= ${MIN_SANDBOX_NODE_MAJOR} ` +
        `(the @fly/sprites SDK is Node ${MIN_SANDBOX_NODE_MAJOR}+ / ESM-only); ` +
        `this realtime process is Node ${process.versions.node}. Build the realtime ` +
        `image on Node ${MIN_SANDBOX_NODE_MAJOR}+ before enabling terminals.`,
    );
  }
}

export async function getRealtimeSpritesSdk(): Promise<SpritesSdk> {
  if (cachedSdk) return cachedSdk;
  assertSandboxRuntime();
  // @fly/sprites is ESM-only. TS 5.8 with module:commonjs preserves dynamic import()
  // as-is (does not lower to require()), so Node 24 in production handles it natively.
  const { SpritesClient } = await import('@fly/sprites');
  const client = new SpritesClient(resolveSpritesToken());
  cachedSdk = {
    getSprite: (name) => client.getSprite(name) as unknown as Promise<SpriteInstanceLike>,
    createSprite: (name, config) => client.createSprite(name, config) as unknown as Promise<SpriteInstanceLike>,
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}
