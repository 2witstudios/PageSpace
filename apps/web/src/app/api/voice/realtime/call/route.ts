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
 * Auth, tier gate and managed-key lookup follow `../transcribe/route.ts`
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
import { PAID_TIERS } from '@/lib/subscription/rate-limit-middleware';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { resolveRealtimeModel } from '@/lib/ai/realtime/session';
import { buildRealtimeTools } from '@/lib/ai/realtime/tools';
import { buildPageSpaceTools } from '@/lib/ai/core/ai-tools';
import { runCallHandshake } from '@/lib/ai/realtime/call-handshake';
import { loadRealtimeSeed } from '@/lib/ai/realtime/seed-loader';
import { voiceSeedDeps } from '@/lib/ai/realtime/voice-runtime-deps';
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

    // Voice starts on a conversation that already exists: the thread is replayed
    // into the session as text before the model speaks. Hard-capped, and an
    // empty seed is a normal outcome (a fresh thread, or one this caller may
    // not read) — never a reason to fail the call.
    const seed = await loadRealtimeSeed(voiceSeedDeps, {
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
        // Built here, at the edge, because the registry has env-dependent
        // branches (the code-execution kill switch) that are the caller's
        // decision. The realtime server cannot build these itself — the
        // registry lives in this app — so they ride the signed internal hop.
        tools: buildRealtimeTools(buildPageSpaceTools()),
        subscriptionTier: tier,
        internalRealtimeUrl: process.env.INTERNAL_REALTIME_URL,
        signHeaders: createSignedBroadcastHeaders,
        logger: loggers.ai,
      },
      {
        offerSdp: sdp,
        userId,
        ...(conversationId === undefined ? {} : { conversationId }),
        seed,
        ...(typeof timezoneRaw === 'string' && timezoneRaw.length > 0
          ? { timezone: timezoneRaw }
          : {}),
        ...(locationContext.success ? { locationContext: locationContext.data } : {}),
      }
    );

    if (!result.ok) {
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
          ...(result.upstream === undefined ? {} : { upstream: result.upstream }),
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
    return NextResponse.json({
      callId: result.callId,
      answerSdp: result.answerSdp,
      attached: result.attached,
    });
  } catch (error) {
    loggers.ai.error('Realtime voice call error', error as Error);
    return NextResponse.json(
      { error: 'Failed to start voice call' },
      { status: 500 }
    );
  }
}
