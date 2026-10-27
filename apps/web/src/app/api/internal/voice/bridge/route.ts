/**
 * POST /api/internal/voice/bridge
 *
 * The realtime server, mid-call, asking the web tier to do the two things only
 * the web tier can: run a PageSpace tool with real permissions, and write a
 * spoken turn into the bound conversation.
 *
 * SERVER-TO-SERVER ONLY. There is no user session on this request — the caller
 * is `apps/realtime`, holding a socket on behalf of a user who authenticated
 * minutes ago at `POST /api/voice/realtime/call`. It proves that with an HMAC
 * over the raw body, the same signature `/api/broadcast` and `/api/realtime/attach`
 * use, verified BEFORE the body is parsed. The acting user id is then taken
 * from the signed payload and every downstream permission check runs against
 * it — a valid signature authenticates the SERVICE, never the user, so nothing
 * below treats it as authorization for a particular person's data.
 *
 * NOT rate-limited or credit-gated here: the call it belongs to was gated at
 * handshake, and its spend is metered continuously by the process holding the
 * socket (see `apps/realtime/src/voice/call-metering.ts`). A second gate on
 * this hop would bill the same call twice.
 */

import { NextResponse } from 'next/server';
import { verifyBroadcastSignature } from '@pagespace/lib/auth/broadcast-auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { resolveRealtimeModel } from '@/lib/ai/realtime/session';
import { handleVoiceBridgeRequest } from '@/lib/ai/realtime/bridge-handler';
import {
  voiceToolDispatchDeps,
  voiceTranscriptDeps,
} from '@/lib/ai/realtime/voice-runtime-deps';

/**
 * A tool result and a transcript are both small. The cap exists so a caller
 * that can sign cannot make us buffer an arbitrary body — the same reason the
 * realtime server caps the bodies it reads on the outbound leg.
 */
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();

    if (rawBody.length > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: 'Payload too large' }, { status: 413 });
    }

    const signature = request.headers.get('x-broadcast-signature');
    if (!signature || !verifyBroadcastSignature(signature, rawBody)) {
      loggers.ai.warn('Voice bridge request failed signature verification');
      return NextResponse.json({ ok: false, error: 'Authentication failed' }, { status: 401 });
    }

    const result = await handleVoiceBridgeRequest(
      {
        toolDeps: voiceToolDispatchDeps,
        transcriptDeps: voiceTranscriptDeps,
        model: resolveRealtimeModel(process.env),
      },
      rawBody,
    );

    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    loggers.ai.error('Voice bridge request failed', error as Error);
    return NextResponse.json({ ok: false, error: 'Internal error' }, { status: 500 });
  }
}
