import { toPersonalSubscriptionTier } from '@pagespace/lib/billing/subscription-tiers';
/**
 * Voice Synthesis (TTS) API Route
 *
 * POST /api/voice/synthesize
 *
 * Converts text to speech using OpenAI's TTS API, on the deployment's managed key.
 * Spends where the conversation it reads aloud spends (SPEND-1), and is allowed only
 * when whoever funds that source is on a paid plan (WAL-8).
 *
 * Supports streaming audio response for low-latency playback.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getManagedProviderKey } from '@/lib/ai/core/ai-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { aiSettingsRepository } from '@/lib/repositories/ai-settings-repository';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
import { PERSONAL_SPEND, conversationSpend } from '@pagespace/lib/billing/spend-target';
import { VOICE_PLAN_REQUIRED, voiceEntitled } from '@/lib/ai/realtime/voice-entitlement';
import { resolveVoiceSpend } from '@/lib/ai/realtime/voice-spend';
import { voiceSpendDeps } from '@/lib/ai/realtime/voice-runtime-deps';
import { resolveRequestContext } from '@/lib/ai/core/resolve-request-context';
import { parseContextRef } from '@/lib/ai/shared/buildContextRef';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { VOICE_MAX_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { calculateVoiceCostDollars, estimateVoiceHoldCents } from '@pagespace/lib/monitoring/voice-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import { emitCreditsUpdated } from '@/lib/subscription/credit-balance';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// Available TTS voices
const VALID_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
type TTSVoice = (typeof VALID_VOICES)[number];

// Available TTS models
const VALID_MODELS = ['tts-1', 'tts-1-hd'] as const;
type TTSModel = (typeof VALID_MODELS)[number];

// Maximum text length (4096 characters for TTS API)
const MAX_TEXT_LENGTH = 4096;

export async function POST(request: Request) {
  // Reservation placed by the credit gate; released here on any path that doesn't
  // hand it off to trackUsage (validation error, provider failure, or throw), so a
  // failed TTS call never strands a hold against the user's spendable balance.
  let holdId: string | undefined;
  // The wallet the hold was placed on, settled against with it (WAL-5).
  let walletId: string | undefined;
  let holdHandedOff = false;
  const startTime = Date.now();

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get managed OpenAI key for TTS (direct api.openai.com, not OpenRouter)
    const openAISettings = getManagedProviderKey('openai_voice');
    if (!openAISettings?.apiKey) {
      return NextResponse.json(
        {
          error: 'Voice mode unavailable',
          message: 'Voice synthesis is not configured on this deployment.',
        },
        { status: 503 }
      );
    }

    const body = await request.json();
    const {
      text,
      voice = 'nova',
      model = 'tts-1',
      speed = 1.0,
      conversationId,
      agentPageId,
      contextRef,
    } = body as {
      text?: string;
      voice?: TTSVoice;
      model?: TTSModel;
      speed?: number;
      conversationId?: unknown;
      agentPageId?: unknown;
      contextRef?: unknown;
    };

    // Validate text
    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Text is required' },
        { status: 400 }
      );
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return NextResponse.json(
        {
          error: 'Text too long',
          message: `Text must be less than ${MAX_TEXT_LENGTH} characters`,
        },
        { status: 400 }
      );
    }

    // Validate voice
    if (!VALID_VOICES.includes(voice)) {
      return NextResponse.json(
        {
          error: 'Invalid voice',
          message: `Valid voices: ${VALID_VOICES.join(', ')}`,
        },
        { status: 400 }
      );
    }

    // Validate model
    if (!VALID_MODELS.includes(model)) {
      return NextResponse.json(
        {
          error: 'Invalid model',
          message: `Valid models: ${VALID_MODELS.join(', ')}`,
        },
        { status: 400 }
      );
    }

    // Validate speed (0.25 to 4.0)
    const speedNumber = typeof speed === 'number' ? speed : Number(speed);
    if (!Number.isFinite(speedNumber)) {
      return NextResponse.json(
        { error: 'Invalid speed', message: 'Speed must be a valid number' },
        { status: 400 }
      );
    }
    const clampedSpeed = Math.min(4.0, Math.max(0.25, speedNumber));

    // Where the speech spends, decided before anything is reserved (SPEND-1): the drive of the
    // conversation it reads aloud — a page conversation's page, a drive conversation's drive, a
    // Global Assistant conversation's drive the caller stands in (resolved from their contextRef
    // behind its own view check) — or personal credits with no drive at all (SPEND-8). The same
    // resolution a realtime voice call takes; a drive it cannot resolve is refused by name, never
    // charged to the caller's own credits instead (SPEND-4).
    const boundConversationId = typeof conversationId === 'string' && conversationId.length > 0 ? conversationId : undefined;
    const boundAgentPageId = typeof agentPageId === 'string' && agentPageId.length > 0 ? agentPageId : undefined;
    const contextDriveId = (await resolveRequestContext(auth, parseContextRef(contextRef)))?.currentDrive?.id;
    const voiceSpend = await resolveVoiceSpend(voiceSpendDeps(auth), {
      userId,
      ...(boundConversationId === undefined ? {} : { conversationId: boundConversationId }),
      ...(boundAgentPageId === undefined ? {} : { agentPageId: boundAgentPageId }),
      ...(contextDriveId === undefined ? {} : { contextDriveId }),
    });
    if (voiceSpend.kind === 'refused') {
      return NextResponse.json(
        {
          error: 'Speech synthesis refused',
          code: voiceSpend.reason,
          message: voiceSpend.reason === 'voice_conversation_forbidden'
            ? 'You do not have access to this conversation.'
            : 'This request could not tell which drive pays for it, so nothing was synthesized or charged.',
        },
        { status: voiceSpend.reason === 'voice_conversation_forbidden' ? 403 : 409 }
      );
    }

    // Reserve credits before billing the provider. Gated AFTER input validation so a
    // malformed request never opens a hold. The reservation is computed from the
    // exact character count (cost × markup) so it accurately reflects this call —
    // tiny for a sentence chunk, up to ~18¢ for a max-length tts-1-hd request —
    // rather than a flat estimate a long request would blow past.
    const tier: SubscriptionTier = isBillingEnabled()
      ? toPersonalSubscriptionTier((await aiSettingsRepository.getUserSettings(userId))?.subscriptionTier)
      : 'free';
    const gate = await canConsumeAI(userId, tier, {
      // In a drive the conversation's stored source applies (SPEND-3), as a typed turn's does.
      spend: voiceSpend.kind === 'drive' ? conversationSpend(voiceSpend.driveId, boundConversationId) : PERSONAL_SPEND,
      estCostCents: estimateVoiceHoldCents(model, { chars: text.length }),
      maxInFlight: VOICE_MAX_INFLIGHT,
    });
    if (!gate.allowed) {
      return creditGateErrorResponse(gate.reason, gate.refusal);
    }
    holdId = gate.holdId;
    walletId = gate.walletId;

    // Voice is a paid feature, judged on the tier of whoever funds the source the gate just held
    // (WAL-8) — the org inside an org drive, the caller on their own credits. A refusal frees the
    // hold in the finally below and charges nothing.
    if (isBillingEnabled() && !voiceEntitled(gate.entitlementTier ?? tier)) {
      return NextResponse.json(VOICE_PLAN_REQUIRED, { status: 403 });
    }

    // Call OpenAI TTS API
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openAISettings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        speed: clampedSpeed,
        response_format: 'mp3',
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      loggers.ai.error('TTS API error', new Error(JSON.stringify(errorData)), {
        status: response.status,
      });

      if (response.status === 401) {
        return NextResponse.json(
          { error: 'Invalid OpenAI API key' },
          { status: 401 }
        );
      }

      return NextResponse.json(
        {
          error: 'Speech synthesis failed',
          message: errorData.error?.message || 'Failed to synthesize speech',
        },
        { status: response.status }
      );
    }

    // Stream the audio response
    const audioData = await response.arrayBuffer();

    // Bill the real provider cost (input characters × published TTS rate) against the
    // user's prepaid credits, with the standard markup applied downstream. This
    // settles the hold and releases it; trackUsage now owns the reservation.
    const costDollars = calculateVoiceCostDollars(model, { chars: text.length });
    holdHandedOff = true;
    await AIMonitoring.trackUsage({
      userId,
      provider: 'openai_voice',
      model,
      source: 'voice',
      providerCostDollars: costDollars,
      // Request latency (ms), matching the chat route. The billing quantity (chars)
      // lives in metadata.
      duration: Date.now() - startTime,
      success: true,
      holdId,
      walletId,
      // The drive the speech was spent in (SPEND-7), for usage attribution.
      driveId: voiceSpend.kind === 'drive' ? voiceSpend.driveId : undefined,
      conversationId: boundConversationId,
      // Deterministic list-price cost (chars × published rate), not a live
      // provider-returned figure — labels the admin-panel coverage honestly.
      costSource: 'list_price',
      metadata: { type: 'voice_tts', voice, chars: text.length },
    });
    void emitCreditsUpdated(userId);

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'voice', resourceId: 'self', details: { operation: 'synthesize', voice, model, textLength: text.length } });

    return new Response(audioData, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audioData.byteLength.toString(),
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    loggers.ai.error('Voice synthesis error', error as Error);
    return NextResponse.json(
      { error: 'Failed to synthesize speech' },
      { status: 500 }
    );
  } finally {
    if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
  }
}
