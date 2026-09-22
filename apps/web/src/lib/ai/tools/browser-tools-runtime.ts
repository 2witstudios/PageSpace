/**
 * Production wiring for the browser tools — the composition root, and the
 * one place in the web app that chooses a substrate.
 *
 * Nothing is exposed unless an operator configures BOTH:
 *  - `BROWSER_SUBSTRATE` — `local` (a worker process per session on this
 *    host; development and onprem) or `sprites` (a Sprite per session, D-19),
 *    and
 *  - `BROWSER_WORKER_SIGNING_KEY` — a base64 PKCS#8 Ed25519 private key. Its
 *    public half is pinned into every worker at provision; the private half
 *    never leaves this process. Unset or unusable ⇒ no browser tools, never
 *    an ephemeral key (the env-bridge rule).
 *
 * `sprites` additionally needs `SPRITES_API_TOKEN` (held by the adapter,
 * used only to reach the worker's port), `BROWSER_WORKER_SPRITE_BOOTSTRAP`
 * (the operator's install command that puts Chromium and the worker bundle in
 * a fresh Sprite) and `BROWSER_WORKER_SPRITE_ENTRY` (the worker entry path in
 * the Sprite). That a Chromium boots in a Sprite is S3's unverified premise
 * (G6a probe #1), so this path stays dark until an approved probe proves it.
 */
import type { Tool } from 'ai';
import { createPrivateKey, createPublicKey, sign as nodeSign, type KeyObject } from 'node:crypto';
import { SpritesClient } from '@fly/sprites';
import { createLocalChromiumSubstrate } from '@pagespace/browser-worker/local-chromium-substrate-adapter';
import { createSpritesBrowserSubstrate, type SpriteHandle } from '@pagespace/browser-worker/sprites-substrate-adapter';
import { createBrowserSessionClient, type BrowserSessionClient } from '@pagespace/browser-worker/browser-session-client';
import { deriveBrowserSessionId } from '@pagespace/browser-worker/derive-browser-session-id';
import type { BrowserSubstrate } from '@pagespace/browser-worker/browser-substrate';
import { createBrowserTools, type OperateBrowser } from './browser-tools';
import { createBrowserMeter, type BrowserBilling } from './browser-metering-adapter';
import { productionSandboxGate, resolveSandboxActorContext } from './sandbox-tools-runtime';

const IDLE_SWEEP_INTERVAL_MS = 60_000;

type ControlKey = { readonly publicKey: string; readonly sign: (message: Uint8Array) => Uint8Array };

const loadControlKey = (raw: string | undefined): ControlKey | null => {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return null;
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'pkcs8' });
  } catch {
    return null;
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') return null;
  return {
    publicKey: createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64'),
    sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)),
  };
};

const buildSpritesSubstrate = (): BrowserSubstrate | null => {
  const token = process.env.SPRITES_API_TOKEN?.trim();
  const bootstrap = process.env.BROWSER_WORKER_SPRITE_BOOTSTRAP?.trim();
  const entry = process.env.BROWSER_WORKER_SPRITE_ENTRY?.trim();
  if (!token || !bootstrap || !entry) return null;
  const client = new SpritesClient(token);
  return createSpritesBrowserSubstrate({
    host: client,
    token,
    installWorker: async (sprite: SpriteHandle) => {
      const handle = await client.getSprite(sprite.name);
      const result = await handle.exec(bootstrap);
      if (result.exitCode !== 0) throw new Error(`browser worker bootstrap failed (${result.exitCode})`);
      return { cmd: 'node', args: [entry] };
    },
  });
};

const buildSubstrate = (): BrowserSubstrate | null => {
  switch (process.env.BROWSER_SUBSTRATE?.trim()) {
    case 'local':
      return createLocalChromiumSubstrate({ entryPath: process.env.BROWSER_WORKER_ENTRY?.trim() || undefined });
    case 'sprites':
      return buildSpritesSubstrate();
    default:
      return null;
  }
};

let cached: { readonly client: BrowserSessionClient<BrowserBilling> } | null | undefined;

/** The session client, or `null` when no substrate/key is configured. Built once per process. */
function browserSessionClient(): BrowserSessionClient<BrowserBilling> | null {
  if (cached !== undefined) return cached?.client ?? null;
  const key = loadControlKey(process.env.BROWSER_WORKER_SIGNING_KEY);
  const substrate = key === null ? null : buildSubstrate();
  if (key === null || substrate === null) {
    cached = null;
    return null;
  }
  const client = createBrowserSessionClient<BrowserBilling>({ substrate, controlPublicKey: key.publicKey, sign: key.sign, meter: createBrowserMeter() });
  setInterval(() => void client.sweepIdle().catch(() => undefined), IDLE_SWEEP_INTERVAL_MS).unref();
  cached = { client };
  return client;
}

export function isBrowserSubstrateConfigured(): boolean {
  return browserSessionClient() !== null;
}

const operate: OperateBrowser = async ({ ctx, operation }) => {
  const client = browserSessionClient();
  if (client === null) return { ok: false, refusal: { reason: 'unavailable', detail: 'The browser is not configured on this server.' } };
  const ownerId = ctx.ownerId ?? ctx.userId;
  const agentId = ctx.agentPageId ?? `global:${ctx.userId}`;
  const sessionId = deriveBrowserSessionId({ tenantId: ctx.tenantId, ownerId, agentId, conversationId: ctx.conversationId });
  return client.operate({
    session: {
      sessionId,
      allowedOrigins: null,
      billing: { driveId: ctx.driveId ?? null, ownerId, agentPageId: ctx.agentPageId ?? null, conversationId: ctx.conversationId },
    },
    agentId,
    operation,
  });
};

/**
 * Production browser tools, or none. Registered next to the sandbox tools
 * behind the CODE_EXECUTION kill switch, and only when a substrate and key
 * are configured — an unconfigured server shows the model no browser at all.
 */
export function buildBrowserTools(): Record<string, Tool> {
  if (!isBrowserSubstrateConfigured()) return {};
  return createBrowserTools({ resolveContext: resolveSandboxActorContext, gate: productionSandboxGate, operate });
}
