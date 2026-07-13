import {
  killSpriteSession,
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
  // tsc(module:commonjs) lowers a direct `import()` to require(), which Node refuses
  // for the ESM-only @fly/sprites ("No exports main defined"). Indirecting through the
  // Function constructor hides the import from the compiler so a NATIVE dynamic import
  // survives — Node's import() loads the ESM SDK from this CJS module.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const importEsm = new Function('s', 'return import(s)') as <T = unknown>(s: string) => Promise<T>;
  const { SpritesClient } = await importEsm<typeof import('@fly/sprites')>('@fly/sprites');
  const client = new SpritesClient(resolveSpritesToken());
  // Bolt `killSession` onto a raw SDK `Sprite` instance — `@fly/sprites` (rc37)
  // exposes no session-kill-by-id, only `attachSession`/`createSession`/`kill()`
  // (a per-command WebSocket signal); see `killSpriteSession`'s doc for why this
  // hits the REST endpoint directly. `baseURL`/`token` are public `readonly`
  // fields on `SpritesClient`, reachable straight off `sprite.client`.
  const withKillSession = (sprite: Awaited<ReturnType<typeof client.getSprite>>): SpriteInstanceLike =>
    Object.assign(sprite, {
      killSession: (sessionId: string) =>
        killSpriteSession({ baseURL: sprite.client.baseURL, token: sprite.client.token }, sprite.name, sessionId),
    }) as unknown as SpriteInstanceLike;
  cachedSdk = {
    getSprite: async (name) => withKillSession(await client.getSprite(name)),
    createSprite: async (name, config) => withKillSession(await client.createSprite(name, config)),
    deleteSprite: (name) => client.deleteSprite(name),
  };
  return cachedSdk;
}
