/**
 * The browser worker process — the one door into a browser session (S3
 * §3.1–§3.3). It runs on the substrate next to Chromium, OUTSIDE the agent
 * VM, and listens on the substrate's single relayed port.
 *
 * Adapter only (Control Board §7.1). Every request is decided by pure
 * modules before anything happens:
 *   verifyControlInstruction → who is asking, for which session, is it fresh
 *   decideActionAdmission    → may this actor act in the current mode
 *   reduceHumanControlMode   → take-over / drained / release / hydrated
 *   decideObservationRelease → may this result leave, to this audience, NOW
 * and this file carries out the verdicts: it queues agent operations one at
 * a time, cancels them on take-over, restarts the browser on release, and
 * counts what it released.
 *
 * The cut is enforced where bytes leave. An agent operation's result is
 * checked against the mode at RETURN time, and against the cancellation
 * epoch it was admitted under: a result from before a take-over is withheld
 * even if the session is back in agent-control by the time it completes,
 * because it describes the context the human was given.
 *
 * `audit().agentResultsReleasedOutsideAgentControl` is the gate exit metric
 * (L5a: "observation cut in human-control mode, event count = 0"); it is
 * incremented at the send point, so a defect anywhere upstream shows here.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createPublicKey, verify as nodeVerify, type KeyObject } from 'node:crypto';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserControlResponse, BrowserOperation, BrowserRefusalReason } from './browser-operation.js';
import { CONTROL_INSTRUCTION_MAX_BYTES, type ControlActor, type HumanInput } from './control-instruction.js';
import { INITIAL_HUMAN_CONTROL_MODE, type HumanControlMode, type HumanControlState } from './human-control-state.js';
import { OBSERVATION_KIND_BY_OPERATION } from './observation-kind.js';
import { verifyControlInstruction } from './verify-control-instruction.js';
import { decideActionAdmission } from './decide-action-admission.js';
import { decideObservationRelease } from './decide-observation-release.js';
import { decideNavigation } from './decide-navigation.js';
import { decideWorkerExpiry } from './decide-worker-expiry.js';
import { reduceHumanControlMode, type HumanControlEvent, type HumanControlTransition } from './reduce-human-control-mode.js';
import { createBrowserDriver, type BrowserDriver, type BrowserDriverOptions } from './browser-driver-client.js';
import { startBrowserEgressProxy, type BrowserEgressProxy, type BrowserEgressProxyOptions } from './browser-egress-proxy-adapter.js';

export type WorkerAudit = {
  readonly mode: HumanControlState;
  readonly agentResultsReleased: number;
  /** Must stay 0: an agent-visible result sent while the agent did not control the session. */
  readonly agentResultsReleasedOutsideAgentControl: number;
  readonly agentResultsSuppressed: number;
  readonly agentActionsRefused: number;
  readonly agentActionsCancelled: number;
  readonly egressRefusals: number;
  readonly browserRestarts: number;
};

export type BrowserControlWorkerOptions = {
  readonly sessionId: string;
  /** Base64 SPKI DER Ed25519 public key; the worker obeys only its signatures. */
  readonly controlPublicKey: string;
  readonly allowedOrigins: readonly string[] | null;
  readonly listen: { readonly host: string; readonly port: number };
  /** Parent of the per-context profile directories. */
  readonly profileRoot?: string;
  readonly executablePath?: string;
  readonly clock?: () => number;
  readonly launchDriver?: (options: BrowserDriverOptions) => Promise<BrowserDriver>;
  readonly egress?: Pick<BrowserEgressProxyOptions, 'resolve' | 'dial'>;
  /** No accepted instruction for this long ⇒ close the browser, delete the profile, stop (`decideWorkerExpiry`). */
  readonly idleShutdownMs?: number;
  /** Called once the worker has shut itself down for idleness. */
  readonly onExpire?: () => void;
  readonly operationDeadlineMs?: number;
};

export type BrowserControlWorker = {
  readonly url: string;
  readonly audit: () => WorkerAudit;
  readonly close: () => Promise<void>;
};

type Reply = { readonly status: number; readonly body: unknown };

/**
 * The longest any one agent operation may hold the queue. Beyond it the page
 * is treated as hostile or wedged: the browser is restarted, so a page that
 * spins its main thread can never keep a human from taking over.
 */
export const OPERATION_DEADLINE_MS = 45_000;
const CLOSE_DEADLINE_MS = 10_000;

const TIMED_OUT = Symbol('timed-out');
const withDeadline = <T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> =>
  Promise.race([work, new Promise<typeof TIMED_OUT>((done) => setTimeout(() => done(TIMED_OUT), ms).unref())]);

const SUPPRESSED: BrowserControlResponse = {
  ok: false,
  refusal: { reason: 'observation-suppressed', detail: 'A person took control of the browser; this result was withheld from the agent.' },
};

const refusal = (reason: BrowserRefusalReason, detail: string): BrowserControlResponse => ({ ok: false, refusal: { reason, detail } });

const MODE_DETAIL: Readonly<Record<Exclude<HumanControlState, 'agent-control'>, string>> = {
  draining: 'A person is taking control of the browser.',
  'human-control': 'A person is controlling the browser; wait until they hand it back.',
  hydrating: 'The browser is restarting after a person used it.',
};

const importControlKey = (controlPublicKey: string): KeyObject => {
  const key = createPublicKey({ key: Buffer.from(controlPublicKey, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('browser worker: control key must be Ed25519');
  return key;
};

export const startBrowserControlWorker = async ({
  sessionId,
  controlPublicKey,
  allowedOrigins,
  listen,
  profileRoot = join(tmpdir(), 'pagespace-browser'),
  executablePath,
  clock = Date.now,
  launchDriver = createBrowserDriver,
  egress,
  idleShutdownMs = 15 * 60 * 1000,
  onExpire,
  operationDeadlineMs = OPERATION_DEADLINE_MS,
}: BrowserControlWorkerOptions): Promise<BrowserControlWorker> => {
  const controlKey = importControlKey(controlPublicKey);
  const verify = (message: Uint8Array, signature: Uint8Array): boolean => {
    try {
      return nodeVerify(null, message, controlKey, signature);
    } catch {
      return false;
    }
  };

  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const proxy: BrowserEgressProxy = await startBrowserEgressProxy({ allowedOrigins, ...egress });

  const launch = async (): Promise<BrowserDriver> =>
    launchDriver({ profileDir: await mkdtemp(join(profileRoot, 'ctx-')), proxyUrl: proxy.url, executablePath });

  let driver: BrowserDriver | null = await launch();
  let mode: HumanControlMode = INITIAL_HUMAN_CONTROL_MODE(clock());
  let epoch = 0;
  let agentQueue: Promise<void> = Promise.resolve();
  let controlQueue: Promise<unknown> = Promise.resolve();
  const seenNonces = new Map<string, number>();
  let lastInstructedAt = clock();
  const counters = {
    agentResultsReleased: 0,
    agentResultsReleasedOutsideAgentControl: 0,
    agentResultsSuppressed: 0,
    agentActionsRefused: 0,
    agentActionsCancelled: 0,
    browserRestarts: 0,
  };

  const apply = (event: HumanControlEvent): HumanControlTransition => {
    const transition = reduceHumanControlMode({ mode, event, now: clock() });
    if (transition.rejected !== null) return transition;
    mode = transition.mode;
    if (transition.effects.includes('cancel-agent-actions')) epoch += 1;
    return transition;
  };

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = controlQueue.then(work, work);
    controlQueue = next.catch(() => undefined);
    return next;
  };

  /** The send point for everything the agent receives. */
  const releaseToAgent = (response: BrowserControlResponse, kind: BrowserOperation['kind'], admittedEpoch: number): BrowserControlResponse => {
    const observation = response.ok ? OBSERVATION_KIND_BY_OPERATION[kind] : 'action-result';
    if (admittedEpoch !== epoch || decideObservationRelease({ mode: mode.state, kind: observation, audience: 'agent' }) === 'suppress') {
      counters.agentResultsSuppressed += 1;
      return SUPPRESSED;
    }
    counters.agentResultsReleased += 1;
    if (mode.state !== 'agent-control') counters.agentResultsReleasedOutsideAgentControl += 1;
    return response;
  };

  const refuseForMode = (): BrowserControlResponse =>
    mode.state === 'agent-control' ? refusal('draining', MODE_DETAIL.draining) : refusal(mode.state, MODE_DETAIL[mode.state]);

  /** Replace the browser with a fresh one in a new profile. The old one is closed, or abandoned if it will not close. */
  const restartBrowser = async (): Promise<void> => {
    const previous = driver;
    driver = null;
    counters.browserRestarts += 1;
    if (previous !== null) await withDeadline(previous.close(), CLOSE_DEADLINE_MS);
    driver = await launch();
  };

  const runAgentOperation = (actor: ControlActor, operation: BrowserOperation): Promise<BrowserControlResponse> => {
    const admission = decideActionAdmission({ mode, actor });
    if (!admission.admit) {
      counters.agentActionsRefused += 1;
      return Promise.resolve(refuseForMode());
    }
    if (operation.kind === 'navigate' || (operation.kind === 'tabs' && operation.action === 'open')) {
      // Hygiene before waking the page: the proxy is the boundary for every
      // connection, but a refusal it can decide without DNS is clearer here.
      const verdict = decideNavigation({ url: operation.url, resolvedAddresses: null, allowedOrigins });
      if (verdict.verdict === 'deny') return Promise.resolve(releaseToAgent(refusal('navigation-denied', verdict.reason), operation.kind, epoch));
    }
    const admittedEpoch = epoch;
    const result = agentQueue.then(async (): Promise<BrowserControlResponse> => {
      if (admittedEpoch !== epoch || driver === null) {
        counters.agentActionsCancelled += 1;
        return refuseForMode();
      }
      const outcome = await withDeadline(driver.run(operation), operationDeadlineMs);
      if (outcome === TIMED_OUT) {
        await restartBrowser();
        return releaseToAgent(refusal('operation-failed', 'The page stopped responding; the browser was restarted.'), operation.kind, admittedEpoch);
      }
      return releaseToAgent(outcome, operation.kind, admittedEpoch);
    });
    agentQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.catch(() => releaseToAgent(refusal('operation-failed', 'The browser operation failed.'), operation.kind, admittedEpoch));
  };

  const takeOver = (userId: string): Promise<Reply> =>
    serialized(async () => {
      const transition = apply({ type: 'take-over', by: { userId } });
      if (transition.rejected !== null) return { status: 409, body: { rejected: transition.rejected, mode: mode.state } };
      if (transition.effects.includes('cancel-agent-actions')) {
        await agentQueue;
        apply({ type: 'drained' });
      }
      return { status: 200, body: { mode: mode.state } };
    });

  const release = (userId: string): Promise<Reply> =>
    serialized(async () => {
      const transition = apply({ type: 'release', by: { userId } });
      if (transition.rejected !== null) return { status: 409, body: { rejected: transition.rejected, mode: mode.state } };
      try {
        await restartBrowser();
        apply({ type: 'hydrated' });
      } catch {
        // Fail closed: the agent stays cut off in `hydrating`.
      }
      return { status: 200, body: { mode: mode.state } };
    });

  const viewFrame = async (): Promise<Reply> => {
    if (decideObservationRelease({ mode: mode.state, kind: 'screenshot', audience: 'human' }) === 'suppress') return { status: 403, body: { error: 'suppressed' } };
    if (driver === null) return { status: 503, body: { error: 'restarting', mode: mode.state } };
    return { status: 200, body: { mode: mode.state, ...(await driver.frame()) } };
  };

  const humanInput = async (actor: ControlActor, input: HumanInput): Promise<Reply> => {
    const admission = decideActionAdmission({ mode, actor });
    if (!admission.admit) return { status: 409, body: { refused: admission.reason } };
    if (driver === null) return { status: 503, body: { error: 'restarting' } };
    await driver.humanInput(input);
    return { status: 200, body: { ok: true } };
  };

  const audit = (): WorkerAudit => ({ mode: mode.state, ...counters, egressRefusals: proxy.refusalCount() });

  const handleControl = async (instruction: string): Promise<Reply> => {
    const now = clock();
    for (const [nonce, expiresAt] of seenNonces) if (expiresAt <= now) seenNonces.delete(nonce);
    const verdict = verifyControlInstruction({
      instruction,
      verify,
      now,
      sessionId,
      seenNonces: new Set(seenNonces.keys()),
    });
    if (!verdict.ok) return { status: 401, body: { error: verdict.reason } };
    seenNonces.set(verdict.claims.nonce, verdict.claims.exp);
    lastInstructedAt = now;

    const { actor, command } = verdict.claims;
    switch (command.type) {
      case 'operation':
        return { status: 200, body: await runAgentOperation(actor, command.operation) };
      case 'take-over':
        return actor.kind === 'human' ? takeOver(actor.userId) : { status: 403, body: { error: 'actor-not-permitted' } };
      case 'release':
        return actor.kind === 'human' ? release(actor.userId) : { status: 403, body: { error: 'actor-not-permitted' } };
      case 'view-frame':
        return viewFrame();
      case 'human-input':
        return humanInput(actor, command.input);
      case 'audit':
        return { status: 200, body: audit() };
    }
  };

  const respond = (res: ServerResponse, { status, body }: Reply): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  };

  /** The body, or `null` once it exceeds the instruction bound (the rest is never buffered). */
  const readInstruction = (req: IncomingMessage): Promise<string | null> =>
    new Promise((done) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > CONTROL_INSTRUCTION_MAX_BYTES) {
          done(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => done(Buffer.concat(chunks).toString('utf8').trim()));
      req.on('error', () => done(null));
    });

  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      req.resume();
      return respond(res, { status: 200, body: { ok: true } });
    }
    if (req.method !== 'POST' || req.url !== '/control') {
      req.resume();
      return respond(res, { status: 404, body: { error: 'not-found' } });
    }
    readInstruction(req)
      .then((instruction) => (instruction === null ? { status: 413, body: { error: 'too-large' } } : handleControl(instruction)))
      .then(
        (reply) => respond(res, reply),
        () => respond(res, { status: 500, body: { error: 'internal' } }),
      );
  });

  await new Promise<void>((done) => server.listen(listen.port, listen.host, done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : listen.port;
  const host = listen.host.includes(':') ? `[${listen.host}]` : listen.host;

  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closed !== null) return closed;
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    closed = (async () => {
      await new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      });
      await driver?.close();
      driver = null;
      await proxy.close();
    })();
    return closed;
  };

  const scheduleExpiry = (delayMs: number): void => {
    expiryTimer = setTimeout(() => {
      const expiry = decideWorkerExpiry({ lastInstructedAt, now: clock(), idleShutdownMs });
      if (!expiry.expire) return scheduleExpiry(expiry.recheckInMs);
      void close().then(() => onExpire?.());
    }, delayMs);
    expiryTimer.unref();
  };
  scheduleExpiry(idleShutdownMs);

  return { url: `http://${host}:${port}`, audit, close };
};
