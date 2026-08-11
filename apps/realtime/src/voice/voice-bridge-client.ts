/**
 * Calling back into the web tier while a call is live.
 *
 * The mirror of `apps/web/src/lib/ai/realtime/call-handshake.ts`'s handoff: same
 * HMAC (`REALTIME_BROADCAST_SECRET` is symmetric), same JSON body, opposite
 * direction. It exists because two things that happen on this socket are owned
 * by `apps/web` and cannot move — the tool registry with the permission checks
 * the tools run internally, and `messageRepository`, whose write is the same
 * transaction that bumps `conversations.rev` and emits the events every chat
 * surface already subscribes to. See `VOICE_CALLBACK_ROUTES` for the full
 * argument, including why metering is deliberately NOT routed through here.
 *
 * TIMEOUTS ARE ASYMMETRIC ON PURPOSE, and the asymmetry follows the WORK behind
 * each hop rather than who is waiting on it. A tool dispatch runs a real
 * PageSpace tool — a page read, a search, a write — so it needs the larger
 * budget or a legitimately slow tool is killed and the model apologises for
 * something that was about to succeed. A transcript is one insert; a budget
 * beyond that would only hold a socket handler open longer for a row nobody is
 * waiting on.
 *
 * Being inside the live turn does NOT argue for a smaller tool budget — it
 * argues for a bounded one. The ceiling exists so a dead web tier becomes
 * something the model can say rather than an unbounded pause; it is not a
 * latency target, and a tool that answers in 300ms still answers in 300ms.
 */

import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import {
  VOICE_CALLBACK_ROUTES,
  type VoiceBridgeRequest,
  type VoiceBridgeResponse,
} from '@pagespace/lib/realtime/voice-bridge-contract';

/**
 * A tool call the caller is waiting through. Long enough for a real page read
 * or a search, short enough that a dead web tier does not hold the conversation
 * open indefinitely — past this the model is told the tool timed out and can
 * say so, which is a far better turn than an unbounded pause.
 */
export const TOOL_DISPATCH_TIMEOUT_MS = 20_000;

/**
 * Half the tool budget, because a transcript is one row. Nothing is blocked on
 * it, which is exactly why it does not get the larger ceiling: a longer wait
 * would buy no additional successes, only a socket handler held open past the
 * point the write was going to fail anyway.
 */
export const TRANSCRIPT_TIMEOUT_MS = 10_000;

export type VoiceBridgeClient = {
  send(request: VoiceBridgeRequest): Promise<VoiceBridgeResponse>;
};

export type VoiceBridgeClientOptions = {
  /** `WEB_APP_URL` in this process. Unset disables the bridge (see below). */
  readonly webUrl: string | undefined;
  readonly fetchFn?: typeof fetch;
  readonly signHeaders?: (body: string) => Record<string, string>;
};

/**
 * Build the client.
 *
 * An unset web URL is a DEGRADE, not a throw — the same trade the outbound
 * direction makes for an unset `INTERNAL_REALTIME_URL`. A voice call with no
 * bridge still connects, still hears, still speaks, and still bills correctly;
 * it just cannot run tools or write transcripts. Refusing to attach instead
 * would trade a partly-working call for no call.
 */
export const createVoiceBridgeClient = (
  options: VoiceBridgeClientOptions,
): VoiceBridgeClient => {
  const {
    webUrl,
    fetchFn = fetch,
    signHeaders = createSignedBroadcastHeaders,
  } = options;

  return {
    async send(request) {
      if (!webUrl) {
        return { ok: false, error: 'Voice bridge is not configured (WEB_APP_URL unset)' };
      }

      const body = JSON.stringify(request);
      const timeoutMs =
        request.kind === 'tool' ? TOOL_DISPATCH_TIMEOUT_MS : TRANSCRIPT_TIMEOUT_MS;

      try {
        const response = await fetchFn(`${webUrl}${VOICE_CALLBACK_ROUTES.bridge}`, {
          method: 'POST',
          headers: signHeaders(body),
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          loggers.realtime.warn('Voice bridge call was refused by the web tier', {
            kind: request.kind,
            callId: request.callId,
            status: response.status,
          });
          return { ok: false, error: `Voice bridge returned ${response.status}` };
        }

        const parsed = (await response.json()) as VoiceBridgeResponse;
        return parsed;
      } catch (error) {
        loggers.realtime.error(
          'Voice bridge call failed',
          error instanceof Error ? error : new Error(String(error)),
          { kind: request.kind, callId: request.callId },
        );
        return { ok: false, error: 'Voice bridge is unreachable' };
      }
    },
  };
};
