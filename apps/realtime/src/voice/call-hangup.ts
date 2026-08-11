/**
 * Ending a call from the server side.
 *
 * Closing our own attached socket stops US listening; it does NOT end the
 * browser's WebRTC session. Without this, every limit the metering layer
 * enforces would be half a limit: we would stop billing and stop transcribing
 * while the user carried on talking to a model nobody was watching. That is
 * worse than not having the limit, so the caps and the hangup ship together.
 *
 * `POST /v1/realtime/calls/{call_id}/hangup` ends a call started over either
 * SIP or WebRTC, addressed by the same `rtc_…` id the `Location` header handed
 * back at call creation, and answers 200 when teardown begins.
 *
 * CREDENTIAL. This process holds exactly one credential for the call: that
 * call's own ephemeral secret, which is what authenticated the attach and stays
 * valid for the socket's life. The managed API key is not here (it never leaves
 * the web tier), so the secret is what is used. If OpenAI refuses it, the
 * failure is logged and our side still tears down — a hangup that does not land
 * degrades to "we stop participating", never to "we keep billing".
 *
 * 404 IS A SUCCESS, NOT A FAILURE. Every teardown path asks for a hangup,
 * including the ordinary one where the user hung up in the browser and the call
 * is already gone. That answers 404, which means the thing this function exists
 * to guarantee is already true. Reporting it as a refusal would put a warning
 * on the most common way a call ends, and a log line that fires on every
 * healthy call is a log line nobody reads on the unhealthy one.
 */

import { loggers } from '@pagespace/lib/logging/logger-config';

export const REALTIME_HANGUP_URL = 'https://api.openai.com/v1/realtime/calls';

/** Teardown is not something a caller waits on for long. */
const HANGUP_TIMEOUT_MS = 5_000;

export type HangupDeps = {
  readonly fetchFn?: typeof fetch;
};

/**
 * Ask OpenAI to end the call. Never throws: every caller is already in a
 * teardown path, and a failure here must not stop the rest of it.
 */
export const hangUpCall = async (
  callId: string,
  secret: string,
  deps: HangupDeps = {},
): Promise<boolean> => {
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const response = await fetchFn(
      `${REALTIME_HANGUP_URL}/${encodeURIComponent(callId)}/hangup`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(HANGUP_TIMEOUT_MS),
      },
    );
    if (response.status === 404) {
      loggers.realtime.debug('Realtime voice call was already ended before hangup', {
        callId,
      });
      return true;
    }
    if (!response.ok) {
      loggers.realtime.warn('Realtime voice hangup was refused', {
        callId,
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    loggers.realtime.warn('Realtime voice hangup failed', {
      callId,
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }
};
