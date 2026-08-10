/**
 * One attached OpenAI realtime call, held open for its whole life.
 *
 * The browser is already in a WebRTC call. This opens a SECOND transport onto
 * the SAME session — `wss://api.openai.com/v1/realtime?call_id=rtc_…` — from
 * which the server owns tools, transcripts and metering while the browser owns
 * only the mic and the speaker.
 *
 * WHY THIS LIVES IN `apps/realtime` AND NOT IN A NEXT ROUTE. `usage` arrives per
 * `response.done` and call totals only exist if something accumulates them, so
 * the socket must survive the whole call — up to an hour. A route handler
 * cannot hold that. This app is a long-lived `tsx` process that already takes
 * signed internal calls from web, so it is the host.
 *
 * TWO MEASURED FACTS SHAPE THE HANDSHAKE, and getting either wrong costs an
 * afternoon of debugging a silent socket:
 *
 * 1. The attach is authenticated by the call's OWN EPHEMERAL SECRET. The API
 *    key fails with `404 call_id_not_found` — it is not rejected as a
 *    credential, it just cannot address a call — and a *fresh* ephemeral secret
 *    fails too. Only the secret minted for this exact call works.
 * 2. An attached socket is SILENT on connect. No `session.created` ever
 *    arrives; that event fired on the browser's data channel before we got
 *    here. Anything gated on `session.created` waits forever. Readiness is:
 *    socket OPEN, then the `session.updated` reply to our own `session.update`.
 *
 * The socket factory is injected, so every path below is testable without a
 * live call.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  EPHEMERAL_SECRET_PREFIX,
  type RealtimeToolWire,
} from '@pagespace/lib/realtime/voice-bridge-contract';

/** Where a server attaches to a call already in progress. */
export const REALTIME_ATTACH_URL = 'wss://api.openai.com/v1/realtime';

/**
 * The socket surface this module actually uses. Declared structurally rather
 * than as `WebSocket` so a test can supply a plain object: the DOM lib's
 * `WebSocket` types `onmessage` as taking a `MessageEvent`, which would drag
 * the whole DOM event hierarchy into a fake for no benefit.
 */
export type AttachSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type AttachSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => AttachSocket;

/**
 * The real factory. Node's global WebSocket DOES send custom headers — verified
 * against a local upgrade handler, which saw the `Authorization` header
 * arrive — but the option is a Node extension that the DOM constructor type
 * does not describe (its second parameter is `protocols`). Hence the one cast,
 * kept to this single line. No `ws` dependency is needed, and `apps/realtime`
 * does not declare one.
 */
export const defaultAttachSocketFactory: AttachSocketFactory = (url, headers) =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as AttachSocket;

/** How long to wait for OPEN + `session.updated` before giving up. */
export const ATTACH_READY_TIMEOUT_MS = 15_000;

/**
 * Hard ceiling on one call. A socket that leaks bills silently for as long as
 * the model keeps the session warm, and nothing else in this process would
 * notice — the browser hanging up is not something the server socket is told
 * about in every failure mode. An hour is far past any real conversation.
 */
export const MAX_CALL_DURATION_MS = 60 * 60 * 1000;

export type AttachFailureCode =
  | 'ephemeral_secret_required'
  | 'socket_closed_before_ready'
  | 'session_update_rejected'
  | 'attach_timeout'
  | 'duration_cap_exceeded'
  | 'socket_error';

export class RealtimeAttachError extends Error {
  constructor(
    readonly code: AttachFailureCode,
    message: string,
    readonly upstream?: unknown,
  ) {
    super(message);
    this.name = 'RealtimeAttachError';
  }
}

/**
 * The seam other leaves build on. B3 (tool dispatch) and B4 (transcript
 * persistence) do NOT open sockets or parse frames — they take a session out of
 * the registry, `subscribe` to its events, and `send` client events back. This
 * module owns the connection, the handshake, the registry entry and teardown,
 * and nothing above that line.
 */
export type RealtimeCallSession = {
  readonly callId: string;
  readonly userId: string;
  readonly conversationId: string | undefined;
  /** Every inbound event, already JSON-parsed. Returns an unsubscribe. */
  subscribe(listener: (event: unknown) => void): () => void;
  /** Send a client event. No-op once the session has ended. */
  send(event: Record<string, unknown>): void;
  /** Idempotent. Closes the socket and fires the close handlers. */
  end(reason: string): void;
  readonly ended: boolean;
};

export type AttachOptions = {
  readonly callId: string;
  readonly secret: string;
  readonly userId: string;
  readonly conversationId?: string;
  readonly tools: readonly RealtimeToolWire[];
  readonly socketFactory?: AttachSocketFactory;
  /** Called once the session stops, for whatever reason. Used to deregister. */
  readonly onClosed?: (callId: string) => void;
  readonly readyTimeoutMs?: number;
  readonly maxDurationMs?: number;
  /** Injected so tests need no real timers. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
};

/** Frames arrive as strings; a malformed one must not throw into the socket. */
const parseFrame = (data: unknown): unknown => {
  if (typeof data !== 'string') return undefined;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
};

const eventType = (event: unknown): string | undefined => {
  if (typeof event !== 'object' || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
};

/**
 * Open a socket onto an existing call and drive it to ready.
 *
 * Resolves only after `session.updated` — the reply to our `session.update`,
 * which is also the moment the tool set is live. Rejects with a NAMED error on
 * every other outcome, because the failures here are otherwise
 * indistinguishable: a wrong credential, an expired secret and a bad call id
 * all present as the same bare `1006` close.
 */
export const attachToCall = (options: AttachOptions): Promise<RealtimeCallSession> => {
  const {
    callId,
    secret,
    userId,
    conversationId,
    tools,
    socketFactory = defaultAttachSocketFactory,
    onClosed,
    readyTimeoutMs = ATTACH_READY_TIMEOUT_MS,
    maxDurationMs = MAX_CALL_DURATION_MS,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;

  // Checked before a socket is opened, because this is THE mistake this stack
  // invites: the API key is the credential everywhere else, and here it is the
  // one credential that cannot work. Failing at the door with a sentence that
  // says so is the difference between a five-second fix and re-deriving
  // `404 call_id_not_found` from a socket that closed without a word.
  if (!secret.startsWith(EPHEMERAL_SECRET_PREFIX)) {
    return Promise.reject(
      new RealtimeAttachError(
        'ephemeral_secret_required',
        `Attaching to ${callId} requires that call's own ephemeral client secret ` +
          `(${EPHEMERAL_SECRET_PREFIX}…). An API key cannot address a call — OpenAI ` +
          'answers 404 call_id_not_found — and neither can a freshly minted secret.',
      ),
    );
  }

  return new Promise<RealtimeCallSession>((resolve, reject) => {
    const listeners = new Set<(event: unknown) => void>();
    let ready = false;
    let ended = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;

    const socket = socketFactory(`${REALTIME_ATTACH_URL}?call_id=${encodeURIComponent(callId)}`, {
      Authorization: `Bearer ${secret}`,
    });

    const clearTimers = () => {
      if (readyTimer !== undefined) clearTimeoutFn(readyTimer);
      if (durationTimer !== undefined) clearTimeoutFn(durationTimer);
      readyTimer = undefined;
      durationTimer = undefined;
    };

    /**
     * The single teardown path. Every ending — clean close, socket error,
     * timeout, explicit end, duration cap — funnels through here, so listeners
     * cannot be left attached and the registry cannot keep a dead entry.
     */
    const teardown = (failure?: RealtimeAttachError) => {
      if (ended) return;
      ended = true;
      clearTimers();
      listeners.clear();
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      try {
        socket.close();
      } catch {
        // Already closing or closed; the point was to stop billing, and it has.
      }
      onClosed?.(callId);
      // A failure before readiness is the attach's answer; after readiness the
      // promise is long settled and the close is just the call ending.
      if (!ready && failure) reject(failure);
    };

    const session: RealtimeCallSession = {
      callId,
      userId,
      conversationId,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      send(event) {
        if (ended) return;
        socket.send(JSON.stringify(event));
      },
      end(reason) {
        loggers.realtime.debug('Realtime voice session ended', { callId, userId, reason });
        teardown();
      },
      get ended() {
        return ended;
      },
    };

    readyTimer = setTimeoutFn(() => {
      teardown(
        new RealtimeAttachError(
          'attach_timeout',
          `Attach to ${callId} did not reach session.updated within ${readyTimeoutMs}ms. ` +
            'Note that an attached socket sends no session.created — readiness is ' +
            'socket OPEN followed by the session.updated reply, and nothing else.',
        ),
      );
    }, readyTimeoutMs);

    durationTimer = setTimeoutFn(() => {
      loggers.realtime.warn('Realtime voice call hit the hard duration cap', {
        callId,
        userId,
        maxDurationMs,
      });
      teardown(
        new RealtimeAttachError(
          'duration_cap_exceeded',
          `Call ${callId} exceeded the ${maxDurationMs}ms duration cap.`,
        ),
      );
    }, maxDurationMs);

    socket.onopen = () => {
      // Tools land here, on the server socket, and therefore never touch the
      // browser. This is also the event whose reply defines readiness.
      socket.send(
        JSON.stringify({
          type: 'session.update',
          session: { type: 'realtime', tools, tool_choice: 'auto' },
        }),
      );
    };

    socket.onmessage = (event) => {
      const parsed = parseFrame(event.data);
      if (parsed === undefined) return;
      const type = eventType(parsed);

      if (!ready) {
        if (type === 'session.updated') {
          ready = true;
          if (readyTimer !== undefined) clearTimeoutFn(readyTimer);
          readyTimer = undefined;
          resolve(session);
        } else if (type === 'error') {
          // A rejected session.update answers with an `error` event and then
          // sits there. Reporting ready anyway would hand B3 a session whose
          // tools were never registered.
          teardown(
            new RealtimeAttachError(
              'session_update_rejected',
              `OpenAI rejected the session.update for ${callId}.`,
              (parsed as { error?: unknown }).error,
            ),
          );
          return;
        }
      }

      // Fan out AFTER the readiness check so a subscriber added during
      // `resolve` does not also receive the frame that resolved it twice.
      for (const listener of listeners) {
        try {
          listener(parsed);
        } catch (error) {
          // One bad subscriber must not tear down a live call for the others.
          loggers.realtime.error(
            'Realtime voice event listener threw',
            error instanceof Error ? error : new Error(String(error)),
            { callId, eventType: type },
          );
        }
      }
    };

    socket.onclose = (event) => {
      teardown(
        new RealtimeAttachError(
          'socket_closed_before_ready',
          `Attach socket for ${callId} closed before the session was ready ` +
            `(code ${event?.code ?? 'unknown'}). The usual cause is a credential that ` +
            `cannot address this call: it must be THIS call's own ephemeral secret ` +
            `(${EPHEMERAL_SECRET_PREFIX}…), not an API key and not a fresh one.`,
        ),
      );
    };

    socket.onerror = () => {
      teardown(
        new RealtimeAttachError(
          'socket_error',
          `Attach socket for ${callId} errored before the session was ready.`,
        ),
      );
    };
  });
};
