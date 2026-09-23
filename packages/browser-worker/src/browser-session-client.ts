/**
 * The web server's side of a browser session: find or provision it on the
 * substrate, sign one instruction per request, send it, meter the session's
 * life, and destroy idle sessions. Adapter only — the substrate, the signer
 * and the meter are injected; the decisions (instruction shape, who may
 * issue what) live in the worker's pure modules, which refuse anything this
 * client gets wrong.
 *
 * Metering (S3 R14): a session is a billable machine like a sandbox. The
 * meter places a hold for the paying principal BEFORE the substrate is asked
 * for anything. While the session lives it is settled every
 * `settleIntervalMs` at its real shape and a fresh hold is taken; a refused
 * fresh hold ends the session. The rest is settled when it ends. A refused
 * hold is a refused session, never an unmetered one.
 *
 * Lifetime (S3 R15): a session idle past `idleTimeoutMs` is destroyed, not
 * paused — no browser profile outlives the work that needed it. The idle
 * clock lives in this process; a session another web instance provisioned
 * is ended by that instance or by the substrate's own reaping.
 */
import { randomBytes } from 'node:crypto';
import type { BrowserControlResponse, BrowserOperation } from './browser-operation.js';
import type { BrowserSessionShape, BrowserSubstrate, ProvisionedBrowserSession, WorkerResponse } from './browser-substrate.js';
import {
  CONTROL_INSTRUCTION_AUDIENCE,
  CONTROL_INSTRUCTION_VERSION,
  type ControlActor,
  type ControlCommand,
  type Ed25519Sign,
} from './control-instruction.js';
import { encodeControlInstruction } from './encode-control-instruction.js';

/** What `open` placed. `payerId` is fixed at open, so a mid-session ownership change cannot move the charge. */
export type BrowserMeterHold = { readonly holdId: string | null; readonly payerId: string };

export type BrowserMeter<B> = {
  /** Places the hold for whoever pays for this session; refuses when they cannot. */
  readonly open: (billing: B) => Promise<{ readonly ok: true; readonly hold: BrowserMeterHold } | { readonly ok: false; readonly reason: string }>;
  /** Settles the session's lifetime at its real shape. */
  readonly close: (input: { readonly billing: B; readonly hold: BrowserMeterHold; readonly activeSeconds: number; readonly shape: BrowserSessionShape; readonly substrate: string }) => Promise<void>;
};

export type BrowserSessionRef<B> = {
  readonly sessionId: string;
  readonly allowedOrigins: readonly string[] | null;
  readonly billing: B;
};

export type BrowserSessionClientOptions<B> = {
  readonly substrate: BrowserSubstrate;
  /** Base64 SPKI DER of the key `sign` signs with; every worker is pinned to it. */
  readonly controlPublicKey: string;
  readonly sign: Ed25519Sign;
  readonly meter: BrowserMeter<B>;
  readonly clock?: () => number;
  readonly idleTimeoutMs?: number;
  readonly instructionTtlMs?: number;
  readonly settleIntervalMs?: number;
};

export type BrowserSessionClient<B> = {
  readonly operate: (input: { readonly session: BrowserSessionRef<B>; readonly agentId: string; readonly operation: BrowserOperation }) => Promise<BrowserControlResponse>;
  /** A human's command through the live pane. Never provisions: there is nothing to watch until the agent starts a session. */
  readonly human: (input: { readonly sessionId: string; readonly userId: string; readonly command: Exclude<ControlCommand, { type: 'operation' }> }) => Promise<WorkerResponse>;
  readonly end: (sessionId: string) => Promise<void>;
  readonly sweepIdle: () => Promise<readonly string[]>;
};

type LiveSession<B> = {
  readonly session: ProvisionedBrowserSession;
  readonly billing: B;
  hold: BrowserMeterHold;
  settledAt: number;
  lastUsedAt: number;
  /** An in-progress renewal, so two concurrent operations never settle the same interval twice. */
  renewal: Promise<string | null> | null;
};

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_INSTRUCTION_TTL_MS = 30_000;
const DEFAULT_SETTLE_INTERVAL_MS = 5 * 60 * 1000;

const unavailable = (detail: string): BrowserControlResponse => ({ ok: false, refusal: { reason: 'unavailable', detail } });

export const createBrowserSessionClient = <B>({
  substrate,
  controlPublicKey,
  sign,
  meter,
  clock = Date.now,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  instructionTtlMs = DEFAULT_INSTRUCTION_TTL_MS,
  settleIntervalMs = DEFAULT_SETTLE_INTERVAL_MS,
}: BrowserSessionClientOptions<B>): BrowserSessionClient<B> => {
  const live = new Map<string, Promise<LiveSession<B> | { readonly refused: string }>>();

  const instruct = (sessionId: string, actor: ControlActor, command: ControlCommand): string => {
    const now = clock();
    return encodeControlInstruction({
      claims: {
        v: CONTROL_INSTRUCTION_VERSION,
        aud: CONTROL_INSTRUCTION_AUDIENCE,
        sid: sessionId,
        iat: now,
        exp: now + instructionTtlMs,
        nonce: randomBytes(18).toString('base64url'),
        actor,
        command,
      },
      sign,
    });
  };

  const send = (session: ProvisionedBrowserSession, actor: ControlActor, command: ControlCommand): Promise<WorkerResponse> =>
    session.send({ method: 'POST', path: '/control', headers: { 'content-type': 'text/plain' }, body: instruct(session.sessionId, actor, command) });

  const open = (ref: BrowserSessionRef<B>): Promise<LiveSession<B> | { readonly refused: string }> => {
    const existing = live.get(ref.sessionId);
    if (existing !== undefined) return existing;
    const opening = (async (): Promise<LiveSession<B> | { readonly refused: string }> => {
      const held = await meter.open(ref.billing);
      if (!held.ok) return { refused: held.reason };
      // The billing clock starts BEFORE provisioning: creating the machine and
      // booting the browser run on the paid substrate too.
      const startedAt = clock();
      try {
        const session = await substrate.provision({ sessionId: ref.sessionId, controlPublicKey, allowedOrigins: ref.allowedOrigins });
        return { session, billing: ref.billing, hold: held.hold, settledAt: startedAt, lastUsedAt: clock(), renewal: null };
      } catch (error) {
        await meter.close({ billing: ref.billing, hold: held.hold, activeSeconds: 0, shape: substrate.shape, substrate: substrate.substrate });
        throw error;
      }
    })();
    live.set(ref.sessionId, opening);
    opening.then(
      (result) => {
        if ('refused' in result) live.delete(ref.sessionId);
      },
      () => live.delete(ref.sessionId),
    );
    return opening;
  };

  const operate: BrowserSessionClient<B>['operate'] = async ({ session: ref, agentId, operation }) => {
    let opened: LiveSession<B> | { readonly refused: string };
    try {
      opened = await open(ref);
    } catch {
      return unavailable('The browser could not be started. Try again shortly.');
    }
    if ('refused' in opened) return { ok: false, refusal: { reason: 'billing-denied', detail: opened.refused } };
    const renewed = await renewIfDue(ref.sessionId, opened);
    if (renewed !== null) return { ok: false, refusal: { reason: 'billing-denied', detail: renewed } };
    opened.lastUsedAt = clock();
    const response = await send(opened.session, { kind: 'agent', agentId }, { type: 'operation', operation }).catch(() => null);
    if (response === null || response.status !== 200) {
      // A worker that cannot answer (exited, expired, unreachable, or no longer
      // pinned to our key) is not a session: settle and remove it, so the next
      // call provisions a fresh one instead of retrying a dead end forever.
      await end(ref.sessionId).catch(() => undefined);
      return unavailable(`The browser did not answer (${response?.status ?? 'no response'}); a fresh one will be started on the next call.`);
    }
    return JSON.parse(response.body) as BrowserControlResponse;
  };

  const human: BrowserSessionClient<B>['human'] = async ({ sessionId, userId, command }) => {
    const entry = live.get(sessionId);
    const opened = entry === undefined ? null : await entry.catch(() => null);
    const session = opened !== null && !('refused' in opened) ? opened.session : await substrate.find(sessionId);
    if (session === null) return { status: 404, body: '{"error":"no-session"}' };
    if (opened !== null && !('refused' in opened)) opened.lastUsedAt = clock();
    return send(session, { kind: 'human', userId }, command);
  };

  const settle = (opened: LiveSession<B>, until: number): Promise<void> =>
    meter.close({
      billing: opened.billing,
      hold: opened.hold,
      activeSeconds: Math.max(0, (until - opened.settledAt) / 1000),
      shape: opened.session.shape,
      substrate: opened.session.substrate,
    });

  /** Settles the elapsed interval and re-holds; returns the refusal when the payer can no longer be held (the session is then ended). */
  const renewIfDue = (sessionId: string, opened: LiveSession<B>): Promise<string | null> => {
    if (opened.renewal !== null) return opened.renewal;
    if (clock() - opened.settledAt < settleIntervalMs) return Promise.resolve(null);
    opened.renewal = renew(sessionId, opened).finally(() => {
      opened.renewal = null;
    });
    return opened.renewal;
  };

  const renew = async (sessionId: string, opened: LiveSession<B>): Promise<string | null> => {
    const now = clock();
    await settle(opened, now);
    opened.settledAt = now;
    const held = await meter.open(opened.billing);
    if (!held.ok) {
      opened.hold = { holdId: null, payerId: opened.hold.payerId };
      live.delete(sessionId);
      await substrate.destroy(sessionId);
      return held.reason;
    }
    opened.hold = held.hold;
    return null;
  };

  const end = async (sessionId: string): Promise<void> => {
    const entry = live.get(sessionId);
    live.delete(sessionId);
    const opened = entry === undefined ? null : await entry.catch(() => null);
    await substrate.destroy(sessionId);
    if (opened !== null && !('refused' in opened)) await settle(opened, clock());
  };

  const sweepIdle = async (): Promise<readonly string[]> => {
    const now = clock();
    const idle: string[] = [];
    for (const [sessionId, entry] of live) {
      const opened = await entry.catch(() => null);
      if (opened !== null && !('refused' in opened) && now - opened.lastUsedAt >= idleTimeoutMs) idle.push(sessionId);
    }
    await Promise.all(idle.map(end));
    return idle;
  };

  return { operate, human, end, sweepIdle };
};
