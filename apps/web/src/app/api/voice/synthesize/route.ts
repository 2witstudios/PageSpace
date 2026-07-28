/**
 * Voice Synthesis (TTS) API Route
 *
 * POST /api/voice/synthesize
 *
 * Converts text to speech using OpenAI's TTS API.
 * Requires the user to have an OpenAI API key configured.
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
import { PAID_TIERS } from '@/lib/subscription/rate-limit-middleware';
import { canConsumeAI } from '@pagespace/lib/billing/credit-gate';
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
  let holdHandedOff = false;
  const startTime = Date.now();

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Free users can't use voice at all; paid users meter against their own credits.
    let tier: SubscriptionTier = 'free';
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
    } = body as {
      text?: string;
      voice?: TTSVoice;
      model?: TTSModel;
      speed?: number;
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

    // Reserve credits before billing the provider. Gated AFTER input validation so a
    // malformed request never opens a hold. The reservation is computed from the
    // exact character count (cost × markup) so it accurately reflects this call —
    // tiny for a sentence chunk, up to ~18¢ for a max-length tts-1-hd request —
    // rather than a flat estimate a long request would blow past.
    const gate = await canConsumeAI(userId, tier, {
      estCostCents: estimateVoiceHoldCents(model, { chars: text.length }),
      maxInFlight: VOICE_MAX_INFLIGHT,
    });
    if (!gate.allowed) {
      return creditGateErrorResponse(gate.reason);
    }
    holdId = gate.holdId;

    // Call OpenAI TTS API. Forwards the caller's abort signal so a client
    // that cancels mid-request (e.g. Read Aloud's Stop button) also cancels
    // the upstream request — otherwise it runs to completion and gets
    // billed regardless of the client having already discarded it.
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
      signal: request.signal,
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
