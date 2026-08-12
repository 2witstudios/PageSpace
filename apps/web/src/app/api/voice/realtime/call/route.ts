/**
 * Realtime Voice Call API Route
 *
 * POST /api/voice/realtime/call
 *
 * The browser's front door to a live voice call. It sends an SDP offer and gets
 * an SDP answer back; this route does the whole handshake with OpenAI on its
 * behalf, so the page never contacts `api.openai.com` and never holds a
 * credential. Our server keeps the call id and hands the call's ephemeral
 * secret straight to the realtime server, which attaches for the duration.
 *
 * Auth, tier gate and managed-key lookup follow `../synthesize/route.ts`
 * exactly — voice is one feature with one entitlement, and a second auth shape
 * here would be a second thing to keep in step.
 *
 * NOT metered here. A realtime call's cost accrues per `response.done` over its
 * whole lifetime, on the socket the realtime server holds; a credit hold taken
 * at handshake time could only ever be a guess at a call that has not happened
 * yet. Metering belongs to the process that sees the usage events.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getManagedProviderKey } from '@/lib/ai/core/ai-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { REALTIME_MAX_SESSION_SECONDS } from '@pagespace/lib/billing/credit-pricing';
import { PAID_TIERS } from '@/lib/subscription/rate-limit-middleware';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { resolveRealtimeModel } from '@/lib/ai/realtime/session';
import { runCallHandshake } from '@/lib/ai/realtime/call-handshake';
import { loadVoiceBinding } from '@/lib/ai/realtime/binding-loader';
import { voiceBindingDeps } from '@/lib/ai/realtime/voice-runtime-deps';
import { voiceLocationContextSchema } from '@pagespace/lib/realtime/voice-bridge-contract';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * An SDP offer is a few kilobytes of text. The cap exists so an authenticated
 * caller cannot make us relay an arbitrarily large body to OpenAI.
 */
const MAX_SDP_BYTES = 256 * 1024;

export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Read once, used twice: the entitlement gate here, and the credit gate the
    // realtime server runs when it starts metering the call. Still only read
    // when billing is on — `canConsumeAI` short-circuits to unlimited otherwise,
    // so the tier it would be handed is a value nothing reads, and a DB round
    // trip for it on every onprem/tenant call would buy nothing.
    let tier: SubscriptionTier = 'free';

    // Free users can't use voice at all — same gate, same message as STT/TTS.
    if (isBillingEnabled()) {
      const user = await aiSettingsRepository.getUserSettings(userId);
      tier = (user?.subscriptionTier ?? 'free') as SubscriptionTier;
      if (!PAID_TIERS.has(tier)) {
        return NextResponse.json(
          {
            error: 'Pro plan required',
            message: 'Voice mode requires a Pro or above subscription.',
            upgradeUrl: '/settings/plan',
          },
          { status: 403 }
        );
      }
    }

    const openAISettings = getManagedProviderKey('openai_voice');
    if (!openAISettings?.apiKey) {
      return NextResponse.json(
        {
          error: 'Voice mode unavailable',
          message: 'Voice mode is not configured on this deployment.',
        },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => undefined);
    const sdp = (body as { sdp?: unknown } | undefined)?.sdp;
    const conversationIdRaw = (body as { conversationId?: unknown } | undefined)?.conversationId;
    const timezoneRaw = (body as { timezone?: unknown } | undefined)?.timezone;
    // Parsed rather than trusted: it is forwarded into a `ToolExecutionContext`,
    // and the tools read page/drive ids off it. Permissions still decide access
    // — a location is a default, never an authorization — but a malformed one
    // should be dropped at the edge rather than carried across two processes.
    const locationContext = voiceLocationContextSchema.safeParse(
      (body as { locationContext?: unknown } | undefined)?.locationContext,
    );

    if (typeof sdp !== 'string' || sdp.length === 0) {
      return NextResponse.json(
        { error: 'No SDP offer provided' },
        { status: 400 }
      );
    }
    if (sdp.length > MAX_SDP_BYTES) {
      return NextResponse.json(
        { error: 'SDP offer too large' },
        { status: 400 }
      );
    }

    const conversationId =
      typeof conversationIdRaw === 'string' && conversationIdRaw.length > 0
        ? conversationIdRaw
        : undefined;

    // Voice starts on a conversation that already exists, so the conversation is
    // what says which assistant is being talked to, what it was told to be, and
    // which tools its owner allowed it — as well as supplying the history
    // replayed into the session as text before the model speaks.
    //
    // Read HERE, from the authorized conversation, and never from the request
    // body: the browser names a conversation, and everything else about the
    // binding is derived behind that conversation's own access check. An empty
    // binding is a normal outcome (a fresh thread, or one this caller may not
    // read) — never a reason to fail the call.
    const binding = await loadVoiceBinding(voiceBindingDeps(auth), {
      userId,
      ...(conversationId === undefined ? {} : { conversationId }),
    });

    const result = await runCallHandshake(
      {
        fetch,
        apiKey: openAISettings.apiKey,
        // Resolved explicitly rather than left to buildSessionConfig's default:
        // the env override is the entire per-deployment model escape hatch, and
        // a default applied deeper down would silently swallow it.
        model: resolveRealtimeModel(process.env),
        // Built with the instructions, from ONE exposure, and carried here on
        // the binding. They are two projections of a single decision — what
        // this agent may reach — and a session that advertises `tool_search`
        // while its prompt never names it is exactly the bug this replaced.
        // Building them separately here also meant a second full registry
        // build on a handshake the caller is waiting on.
        //
        // Still built in this app rather than the realtime server: the registry
        // lives here and has env-dependent branches (the code-execution kill
        // switch), so the definitions ride the signed internal hop.
        tools: binding.tools,
        subscriptionTier: tier,
        internalRealtimeUrl: process.env.INTERNAL_REALTIME_URL,
        signHeaders: createSignedBroadcastHeaders,
        logger: loggers.ai,
      },
      {
        offerSdp: sdp,
        userId,
        ...(conversationId === undefined ? {} : { conversationId }),
        seed: binding.seed,
        instructions: binding.instructions,
        ...(binding.assistant === undefined ? {} : { assistant: binding.assistant }),
        ...(typeof timezoneRaw === 'string' && timezoneRaw.length > 0
          ? { timezone: timezoneRaw }
          : {}),
        ...(locationContext.success ? { locationContext: locationContext.data } : {}),
      }
    );

    if (!result.ok) {
      // An admission refusal is a POLICY outcome, not a malfunction: the credit
      // gate or the concurrency cap answered, the just-created OpenAI call has
      // been hung up, and the caller needs the refusal itself — 402 or 429 —
      // rather than a 502 that reads as "try again, something broke".
      if (result.code === 'admission_refused') {
        loggers.ai.info('Realtime voice call refused at admission', {
          userId,
          upstreamStatus: result.upstreamStatus,
        });
        return NextResponse.json(
          { error: 'Voice call refused', code: result.code, message: result.message },
          { status: result.upstreamStatus ?? 429 }
        );
      }

      loggers.ai.error(
        'Realtime voice handshake failed',
        new Error(result.message),
        { userId, code: result.code, upstreamStatus: result.upstreamStatus }
      );
      // 502, not the upstream status: a bare 403 from OpenAI would be
      // indistinguishable from THIS route's own 403 (free tier), and the two
      // need entirely different fixes. The upstream status and body are
      // reported as data instead — which is the only way a bad
      // OPENAI_REALTIME_MODEL is ever visible, since the mint accepts it.
      return NextResponse.json(
        {
          error: 'Voice call failed',
          code: result.code,
          message: result.message,
          ...(result.upstreamStatus === undefined
            ? {}
            : { upstreamStatus: result.upstreamStatus }),
          // ONLY the calls-endpoint body. That is the one that makes a bad
          // OPENAI_REALTIME_MODEL visible, which is the entire reason this
          // passthrough exists. A `mint_failed` body describes the managed API
          // key request instead — it can name the organization, the quota
          // state or a masked key — and no authenticated caller has any use
          // for that.
          ...(result.code === 'realtime_call_rejected' && result.upstream !== undefined
            ? { upstream: result.upstream }
            : {}),
        },
        { status: 502 }
      );
    }

    auditRequest(request, {
      eventType: 'data.read',
      userId,
      resourceType: 'voice',
      resourceId: result.callId,
      details: { operation: 'realtime_call_start', attached: result.attached },
    });

    // The ephemeral secret is deliberately absent: it never leaves the server.
    //
    // `maxDurationMs` is here because the CLIENT cannot derive it and needs it.
    // A call is hung up by the realtime server once it passes
    // REALTIME_MAX_SESSION_SECONDS — a per-deployment env value the browser has
    // no access to — and the browser's job is to chain into a fresh call bound
    // to the same conversation shortly BEFORE that lands, so a long
    // conversation outlives the ceiling that bounds a single call. The
    // alternative is a client-side copy of a server env var, which is a copy
    // that drifts, and whose failure mode is a user cut off mid-sentence on the
    // one deployment that tuned it.
    //
    // The realtime server also caps a socket at an hour, so the true ceiling is
    // the smaller of the two. That constant lives in `apps/realtime` and is not
    // importable here (there is no dependency edge, deliberately), so this
    // reports the cap THIS tier owns — correct unless a deployment sets
    // REALTIME_MAX_SESSION_SECONDS above 3600, at which point the socket's hour
    // binds first and the chain lands late rather than early.
    return NextResponse.json({
      callId: result.callId,
      answerSdp: result.answerSdp,
      attached: result.attached,
      maxDurationMs: REALTIME_MAX_SESSION_SECONDS * 1000,
    });
  } catch (error) {
    loggers.ai.error('Realtime voice call error', error as Error);
    return NextResponse.json(
      { error: 'Failed to start voice call' },
      { status: 500 }
    );
  }
}
