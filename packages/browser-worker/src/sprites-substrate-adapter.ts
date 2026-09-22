/**
 * The SPRITES substrate — D-19 / S3 Option 1: a separate Sprite (its own
 * Firecracker VM) per browser session, the worker inside it on the Sprite's
 * one relayed port, destroyed when the session ends. This is the only file
 * in the system that knows a browser session lives on Sprites.
 *
 * What it does with the platform, and what it deliberately never does:
 *  - create the Sprite at the browser's real shape (2 vCPU / 2 GB, S3 §3.6),
 *    so metering bills what runs (R14);
 *  - apply the DNS backstop (`planBrowserNetworkPolicy`) before the worker
 *    starts — the proxy in the worker is the control, this bounds it;
 *  - start the worker as a Sprite service on port 8080, configured only
 *    through its argv environment: session id, PUBLIC control key, pins.
 *    Nothing secret goes into the Sprite;
 *  - reach the worker only through the Sprite URL with the org token, which
 *    stays in this closure (`send`); the edge answers anyone else with SSO;
 *  - NEVER checkpoint, snapshot or hibernate a browser Sprite: `destroy`
 *    deletes it, so no disk ever holds a live profile (R3, R15).
 *
 * The SDK is reached through the narrow structural {@link SpritesHost} so
 * this package takes no dependency on it; the composition root passes a real
 * `SpritesClient`. Getting Chromium and the worker bundle INTO the Sprite is
 * the `installWorker` step: that it works at all in a Sprite is S3's
 * unverified premise (G6a probe #1), gated behind real-substrate approval.
 */
import type { BrowserSessionShape, BrowserSessionSpec, BrowserSubstrate, ProvisionedBrowserSession, WorkerRequest, WorkerResponse } from './browser-substrate.js';
import { browserSpriteName } from './browser-sprite-name.js';
import { planBrowserNetworkPolicy, type BrowserNetworkPolicy } from './plan-browser-network-policy.js';

export type SpriteHandle = {
  readonly name: string;
  readonly url?: string;
  readonly updateNetworkPolicy: (policy: { rules: { domain?: string; action?: 'allow' | 'deny' }[] }) => Promise<void>;
  readonly createService: (serviceName: string, config: { cmd: string; args?: string[]; httpPort?: number }) => Promise<unknown>;
};

export type SpritesHost = {
  readonly createSprite: (name: string, config?: { ramMB?: number; cpus?: number }) => Promise<SpriteHandle>;
  readonly getSprite: (name: string) => Promise<SpriteHandle>;
  readonly deleteSprite: (name: string) => Promise<void>;
};

export type SpritesSubstrateOptions = {
  readonly host: SpritesHost;
  /** The org token the Sprite URL requires. Held in this closure only. */
  readonly token: string;
  /** Puts Chromium and the worker bundle in a fresh Sprite; returns the worker's command line. */
  readonly installWorker: (sprite: SpriteHandle) => Promise<{ readonly cmd: string; readonly args: readonly string[] }>;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly shape?: BrowserSessionShape;
  readonly readyTimeoutMs?: number;
};

const WORKER_SERVICE = 'pagespace-browser-worker';
const WORKER_PORT = 8080;
/** A reused Sprite wakes in seconds; one that does not answer by then is replaced. */
const REUSE_HEALTH_TIMEOUT_MS = 10_000;

const toSdkPolicy = (policy: BrowserNetworkPolicy): { rules: { domain?: string; action?: 'allow' | 'deny' }[] } => ({
  rules: policy.rules.map((rule) => ({ domain: rule.domain, action: rule.action })),
});

export const createSpritesBrowserSubstrate = ({
  host,
  token,
  installWorker,
  fetchImpl = fetch,
  clock = Date.now,
  shape = { cpus: 2, memoryGB: 2 },
  readyTimeoutMs = 60_000,
}: SpritesSubstrateOptions): BrowserSubstrate => {
  const sessionFor = (sessionId: string, sprite: SpriteHandle, provisionedAt: number): ProvisionedBrowserSession => {
    const baseUrl = sprite.url;
    const send = async (request: WorkerRequest): Promise<WorkerResponse> => {
      if (baseUrl === undefined) return { status: 503, body: '{"error":"sprite-url-missing"}' };
      const response = await fetchImpl(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
        body: request.body,
        redirect: 'manual',
      });
      return { status: response.status, body: await response.text() };
    };
    return { sessionId, substrate: 'sprites', shape, provisionedAt, send };
  };

  const waitReady = async (session: ProvisionedBrowserSession, timeoutMs: number = readyTimeoutMs): Promise<void> => {
    const deadline = clock() + timeoutMs;
    while (clock() < deadline) {
      const health = await session.send({ method: 'GET', path: '/healthz', headers: {}, body: null }).catch(() => null);
      if (health?.status === 200) return;
      await new Promise((done) => setTimeout(done, 1_000));
    }
    throw new Error('browser worker did not become healthy in its Sprite');
  };

  const find = async (sessionId: string): Promise<ProvisionedBrowserSession | null> => {
    const sprite = await host.getSprite(browserSpriteName(sessionId)).catch(() => null);
    return sprite === null ? null : sessionFor(sessionId, sprite, clock());
  };

  const provision = async (spec: BrowserSessionSpec): Promise<ProvisionedBrowserSession> => {
    const live = await find(spec.sessionId);
    if (live !== null) {
      // A Sprite left by a failed delete, or whose worker expired itself, is
      // not a session: prove the worker answers, else replace the Sprite.
      const healthy = await waitReady(live, REUSE_HEALTH_TIMEOUT_MS).then(() => true, () => false);
      if (healthy) return live;
      await host.deleteSprite(browserSpriteName(spec.sessionId)).catch(() => undefined);
    }
    const provisionedAt = clock();
    const sprite = await host.createSprite(browserSpriteName(spec.sessionId), { cpus: shape.cpus, ramMB: shape.memoryGB * 1024 });
    try {
      const { cmd, args } = await installWorker(sprite);
      await sprite.updateNetworkPolicy(toSdkPolicy(planBrowserNetworkPolicy({ allowedOrigins: spec.allowedOrigins })));
      const env = [
        `BROWSER_SESSION_ID=${spec.sessionId}`,
        `BROWSER_CONTROL_PUBLIC_KEY=${spec.controlPublicKey}`,
        'BROWSER_WORKER_HOST=0.0.0.0',
        `BROWSER_WORKER_PORT=${WORKER_PORT}`,
        ...(spec.allowedOrigins === null ? [] : [`BROWSER_ALLOWED_ORIGINS=${JSON.stringify(spec.allowedOrigins)}`]),
      ];
      await sprite.createService(WORKER_SERVICE, { cmd: 'env', args: [...env, cmd, ...args], httpPort: WORKER_PORT });
      const session = sessionFor(spec.sessionId, sprite, provisionedAt);
      await waitReady(session);
      return session;
    } catch (error) {
      await host.deleteSprite(sprite.name).catch(() => undefined);
      throw error;
    }
  };

  const destroy = async (sessionId: string): Promise<void> => {
    await host.deleteSprite(browserSpriteName(sessionId)).catch(() => undefined);
  };

  return { substrate: 'sprites', shape, provision, find, destroy };
};
