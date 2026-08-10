/**
 * `POST /api/realtime/attach` — the web tier handing us a live call.
 *
 * The body carries a real OpenAI ephemeral credential, so this endpoint is at
 * least as protected as `/api/broadcast`: the caller proves it is the web
 * backend with an HMAC over the raw body, and that check runs in `index.ts`
 * BEFORE this handler ever parses a field. Nothing here re-decides user access
 * — the web tier already gated voice on the user's tier at the one policy site,
 * exactly as the shell bridge does.
 *
 * The handler itself takes its dependencies as arguments and returns
 * `{ status, body }`, the shape `shell-io.ts` established, so the whole
 * admission path is testable without a socket, a signature, or a server.
 */

import {
  realtimeAttachPayloadSchema,
  type RealtimeAttachResult,
} from '@pagespace/lib/realtime/voice-bridge-contract';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  attachToCall,
  RealtimeAttachError,
  type AttachOptions,
  type RealtimeCallSession,
} from './realtime-call-session';
import { realtimeCallRegistry, type RealtimeCallRegistry } from './realtime-call-registry';

export type AttachHandlerDeps = {
  readonly registry: RealtimeCallRegistry;
  readonly attach: (options: AttachOptions) => Promise<RealtimeCallSession>;
};

export const defaultAttachHandlerDeps: AttachHandlerDeps = {
  registry: realtimeCallRegistry,
  attach: attachToCall,
};

export type AttachHandlerResponse = {
  readonly status: number;
  readonly body: RealtimeAttachResult;
};

/**
 * Validate, admit, attach, register.
 *
 * The failure statuses are chosen so the web tier can tell apart the three
 * things it might do about them: 400 means the payload was wrong (fix the
 * caller), 429 means we are full (retry later), 502 means OpenAI would not give
 * us the session (the call is degraded, not the request). All three still let
 * the browser keep a working audio call — web treats the whole handoff as
 * best-effort — so the distinction exists for operators, not for control flow.
 */
export const handleRealtimeAttachRequest = async (
  deps: AttachHandlerDeps,
  rawBody: string,
): Promise<AttachHandlerResponse> => {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { success: false, error: 'Invalid JSON' } };
  }

  const parsed = realtimeAttachPayloadSchema.safeParse(json);
  if (!parsed.success) {
    // The message is reported but the payload is NOT logged: it held a secret.
    const reason = parsed.error.issues[0]?.message ?? 'Invalid attach payload';
    loggers.realtime.warn('Realtime attach payload rejected', { reason });
    return { status: 400, body: { success: false, error: reason } };
  }

  const { callId, secret, userId, conversationId, tools } = parsed.data;

  // Claimed synchronously, before the first `await`. Checking the live count
  // and attaching afterwards would let every simultaneous request past a cap of
  // one, because they would all observe the same pre-attach size.
  if (!deps.registry.reserveSlot()) {
    loggers.realtime.warn('Realtime attach refused: concurrent call cap reached', {
      callId,
      userId,
      live: deps.registry.size,
    });
    return {
      status: 429,
      body: { success: false, error: 'Too many concurrent voice calls' },
    };
  }

  try {
    const session = await deps.attach({
      callId,
      secret,
      userId,
      conversationId,
      tools,
      // Deregistration is wired at attach time rather than after the await, so
      // a socket that dies during the handshake cannot leave an entry behind.
      onClosed: (id) => deps.registry.unregister(id),
    });
    deps.registry.register(session);

    loggers.realtime.info('Realtime voice call attached', {
      callId,
      userId,
      conversationId,
      toolCount: tools.length,
      live: deps.registry.size,
    });
    return { status: 200, body: { success: true, callId } };
  } catch (error) {
    const code = error instanceof RealtimeAttachError ? error.code : 'attach_failed';
    loggers.realtime.error(
      'Realtime voice attach failed',
      error instanceof Error ? error : new Error(String(error)),
      { callId, userId, code },
    );
    return {
      status: 502,
      body: {
        success: false,
        error: error instanceof Error ? error.message : 'Attach failed',
      },
    };
  } finally {
    // Released on every path: the slot's job ended the moment the call either
    // entered the registry (where it is now counted) or failed to.
    deps.registry.releaseSlot();
  }
};
