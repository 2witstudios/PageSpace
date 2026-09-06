/**
 * The bridge socket — the machine end of `apps/web/src/app/api/env-bridge/ws`
 * (invariants 1, 2, 6, 8). Lifted from `apps/desktop/src/main/ws-client.ts`:
 * reconnect with exponential backoff (1 s doubling to 30 s), an immediate
 * retry when the server says the token expired, a heartbeat watchdog, and a
 * graceful close. What changed: Electron's stored session token is replaced
 * by a token EARNED on every (re)connect through the machine key
 * (`mintToken`, the challenge/response in `token.ts`) and never cached — the
 * `env:bridge` token is short-lived by policy; and the session lifecycle is
 * no longer ad-hoc string checks but the pure reducer `reduceBridgeSession`,
 * whose effects (`send`, `dispatch`, `reject`, `deleteKey`,
 * `schedule_reconnect`) this module performs.
 *
 * Outbound only: this file opens a client socket and nothing else. It never
 * listens (a grep test pins that for the whole folder).
 *
 * Handshake: on `open` the reducer takes `socket_open` with the signed hello
 * and emits `send`. The server's FIRST frame after a valid hello is a `ping`
 * (the codec has no ack frame; see the route) — that ping is fed to the
 * reducer as `hello_ack` and then dispatched like any ping. Any other frame
 * before that ack is rejected by the reducer (`not_authorized`) and audited;
 * a `revoke` is dispatched from every state so revocation can never be
 * delayed by not being authorized yet.
 */
import { decodeFrame, encodeFrame, type Frame, type FrameLimits } from '@pagespace/lib/env-bridge/frame-codec';
import { initialBridgeSession, reduceBridgeSession, type BridgeEffect, type BridgeSessionState, type BridgeStatus, type HelloFrame } from '@pagespace/lib/env-bridge/bridge-session';
import type { AuditLog } from './audit-log.js';
import type { Dispatcher } from './dispatcher.js';

/** The slice of `ws.WebSocket` this module uses; tests supply an EventEmitter. */
export interface BridgeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: { toString(): string }) => void): unknown;
  on(event: 'close', listener: (code: number, reason: { toString(): string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => BridgeSocket;

export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  /** Delay before reconnecting when the server closed because the token expired. */
  readonly expiredRetryMs: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 1_000, maxMs: 30_000, expiredRetryMs: 500 };
/** Three missed server pings (30 s cadence) — matches the server's own LOCAL_ENV_HEARTBEAT_WINDOW_MS. */
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
export const DEFAULT_FRAME_LIMITS: FrameLimits = { maxFrameBytes: 1024 * 1024 };

export interface BridgeConnectionDeps {
  readonly url: string;
  /** Called on EVERY connect; never cached. */
  readonly mintToken: () => Promise<string>;
  /** The signed hello for this connect (policy digest may have changed). */
  readonly hello: () => HelloFrame;
  readonly dispatcher: Dispatcher;
  readonly audit: AuditLog;
  readonly createSocket: SocketFactory;
  /** The `deleteKey` effect: remove the machine credential from the store. */
  readonly deleteKey: () => Promise<void>;
  readonly onRevoked: () => void;
  readonly log: (line: string) => void;
  readonly limits: FrameLimits;
  readonly backoff: BackoffPolicy;
  readonly idleTimeoutMs: number;
}

export interface BridgeConnectionStatus {
  readonly session: BridgeStatus;
  readonly attempts: number;
  readonly stopped: boolean;
}

export interface BridgeConnection {
  start(): void;
  /** Ctrl-C / `env disconnect`: close cleanly and never reconnect. */
  stop(reason: string): void;
  status(): BridgeConnectionStatus;
}

const EXPIRED_REASON_RE = /expired/i;
const OPEN = 1;

export function createBridgeConnection(deps: BridgeConnectionDeps): BridgeConnection {
  let session: BridgeSessionState = initialBridgeSession();
  let socket: BridgeSocket | null = null;
  let attempts = 0;
  let stopped = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReconnect = () => {
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
  const clearIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = (target: BridgeSocket) => {
    clearIdle();
    idleTimer = setTimeout(() => {
      deps.log(`no server heartbeat for ${deps.idleTimeoutMs} ms; reconnecting`);
      target.terminate();
    }, deps.idleTimeoutMs);
  };

  const send = (target: BridgeSocket, frame: Frame) => {
    if (target.readyState !== OPEN) return;
    try {
      target.send(encodeFrame(frame));
    } catch (error) {
      deps.log(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const scheduleReconnect = (delayMs: number) => {
    if (stopped || session.status === 'revoked') return;
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const backoffDelay = () => {
    attempts += 1;
    return Math.min(deps.backoff.initialMs * 2 ** (attempts - 1), deps.backoff.maxMs);
  };

  const perform = async (target: BridgeSocket, effects: readonly BridgeEffect[], frame: Frame | null) => {
    for (const effect of effects) {
      switch (effect.type) {
        case 'send':
          send(target, effect.frame);
          break;
        case 'dispatch': {
          const result = await deps.dispatcher.handle(effect.frame);
          if (result.kind === 'reply') send(target, result.frame);
          else if (result.kind === 'revoke_verified') await revoke(target);
          break;
        }
        case 'reject':
          await deps.audit.record({ grantId: null, principal: null, op: frame?.type ?? null, verdict: `rejected:${effect.reason}`, argsHash: null, exitCode: null });
          break;
        case 'deleteKey':
          await deps.deleteKey();
          break;
        case 'schedule_reconnect':
          // Performed by the close handler, which knows the close reason.
          break;
      }
    }
  };

  const revoke = async (target: BridgeSocket) => {
    const reduction = reduceBridgeSession(session, { type: 'revoke_verified' });
    session = reduction.state;
    await perform(target, reduction.effects, null);
    clearReconnect();
    clearIdle();
    try {
      target.close(1000, 'revoked');
    } catch {
      // already gone
    }
    deps.onRevoked();
  };

  const onMessage = async (target: BridgeSocket, raw: string) => {
    const decoded = decodeFrame(raw, deps.limits);
    if (!decoded.ok) {
      await deps.audit.record({ grantId: null, principal: null, op: null, verdict: `dropped:${decoded.reason}`, argsHash: null, exitCode: null });
      return;
    }
    const frame = decoded.frame;
    if (frame.type === 'ping') armIdle(target);
    if (session.status === 'hello_sent' && frame.type === 'ping') {
      // The server's first ping after a valid hello IS the acknowledgement.
      const ack = reduceBridgeSession(session, { type: 'hello_ack' });
      session = ack.state;
      attempts = 0;
      deps.log('authorized');
      await perform(target, ack.effects, frame);
    }
    const reduction = reduceBridgeSession(session, { type: 'frame', frame });
    session = reduction.state;
    await perform(target, reduction.effects, frame);
  };

  const connect = async () => {
    if (stopped) return;
    const started = reduceBridgeSession(session, { type: 'connect' });
    if (started.effects.some((effect) => effect.type === 'reject')) return;
    session = started.state;

    let token: string;
    try {
      token = await deps.mintToken();
    } catch (error) {
      deps.log(`token refused: ${error instanceof Error ? error.message : String(error)}`);
      session = reduceBridgeSession(session, { type: 'disconnect' }).state;
      scheduleReconnect(backoffDelay());
      return;
    }
    if (stopped) return;

    let target: BridgeSocket;
    try {
      target = deps.createSocket(deps.url, { Authorization: `Bearer ${token}` });
    } catch (error) {
      deps.log(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
      session = reduceBridgeSession(session, { type: 'disconnect' }).state;
      scheduleReconnect(backoffDelay());
      return;
    }
    socket = target;
    deps.log(`connecting to ${deps.url}`);

    target.on('open', () => {
      const opened = reduceBridgeSession(session, { type: 'socket_open', hello: deps.hello() });
      session = opened.state;
      void perform(target, opened.effects, null);
      armIdle(target);
    });
    target.on('message', (data) => {
      onMessage(target, data.toString()).catch((error) => deps.log(`frame handling failed: ${error instanceof Error ? error.message : String(error)}`));
    });
    target.on('error', (error) => {
      deps.log(`socket error: ${error.message}`);
    });
    target.on('close', (code, reason) => {
      clearIdle();
      if (socket === target) socket = null;
      const reasonText = reason.toString();
      deps.log(`disconnected (${code}${reasonText ? ` ${reasonText}` : ''})`);
      const reduction = reduceBridgeSession(session, { type: 'disconnect' });
      session = reduction.state;
      if (stopped || session.status === 'revoked') return;
      if (!reduction.effects.some((effect) => effect.type === 'schedule_reconnect')) return;
      if (EXPIRED_REASON_RE.test(reasonText)) {
        attempts = 0;
        scheduleReconnect(deps.backoff.expiredRetryMs);
      } else {
        scheduleReconnect(backoffDelay());
      }
    });
  };

  return {
    start() {
      void connect();
    },
    stop(reason) {
      stopped = true;
      clearReconnect();
      clearIdle();
      if (socket !== null) {
        try {
          socket.close(1000, reason);
        } catch {
          // already gone
        }
      }
    },
    status: () => ({ session: session.status, attempts, stopped }),
  };
}
