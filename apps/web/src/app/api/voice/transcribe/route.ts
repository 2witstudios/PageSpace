/**
 * Voice Transcription API Route
 *
 * POST /api/voice/transcribe
 *
 * Transcribes audio to text using OpenAI's Whisper API.
 * Requires the user to have an OpenAI API key configured.
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
import { VOICE_HOLD_ESTIMATE_CENTS, VOICE_MAX_INFLIGHT } from '@pagespace/lib/billing/credit-pricing';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { calculateVoiceCostDollars } from '@pagespace/lib/monitoring/voice-pricing';
import type { SubscriptionTier } from '@pagespace/lib/services/subscription-utils';
import { creditGateErrorResponse } from '@/lib/subscription/credit-gate-response';
import { emitCreditsUpdated } from '@/lib/subscription/credit-balance';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// Supported audio formats for Whisper API
const SUPPORTED_FORMATS = [
  'audio/flac',
  'audio/m4a',
  'audio/mp3',
  'audio/mp4',
  'audio/mpeg',
  'audio/mpga',
  'audio/oga',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
];

export async function POST(request: Request) {
  // Reservation placed by the credit gate; released here on any path that doesn't
  // hand it off to trackUsage (validation error, provider failure, or throw), so a
  // failed STT call never strands a hold against the user's spendable balance.
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
            upgradeUrl: '/settings/billing',
          },
          { status: 403 }
        );
      }
    }

    // Get managed OpenAI key for Whisper
    const openAISettings = getManagedProviderKey('openai');
    if (!openAISettings?.apiKey) {
      return NextResponse.json(
        {
          error: 'Voice mode unavailable',
          message: 'Voice transcription is not configured on this deployment.',
        },
        { status: 503 }
      );
    }

    // Get the audio file from the request
    const formData = await request.formData();
    const audioFile = formData.get('audio') as File | null;
    const language = formData.get('language') as string | null;

    if (!audioFile) {
      return NextResponse.json(
        { error: 'No audio file provided' },
        { status: 400 }
      );
    }

    // Validate file type
    if (!SUPPORTED_FORMATS.includes(audioFile.type) && !audioFile.type.startsWith('audio/')) {
      return NextResponse.json(
        {
          error: 'Unsupported audio format',
          message: `Supported formats: ${SUPPORTED_FORMATS.join(', ')}`,
        },
        { status: 400 }
      );
    }

    // Validate file size (max 25MB for Whisper API)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (audioFile.size > maxSize) {
      return NextResponse.json(
        {
          error: 'File too large',
          message: 'Audio file must be less than 25MB',
        },
        { status: 400 }
      );
    }

    // Reserve credits before billing the provider. Gated AFTER input validation so a
    // malformed request never opens a hold. STT can't know the audio duration (and
    // thus the real cost) until Whisper responds, so it reserves the small flat
    // VOICE_HOLD_ESTIMATE_CENTS; the real cost settles exactly afterwards. Blocks
    // out-of-credit paid users only once CREDITS_ENFORCEMENT_ENABLED is on; otherwise
    // it still books the hold and records spend (dark launch, same as chat).
    const gate = await canConsumeAI(userId, tier, {
      estCostCents: VOICE_HOLD_ESTIMATE_CENTS,
      maxInFlight: VOICE_MAX_INFLIGHT,
    });
    if (!gate.allowed) {
      return creditGateErrorResponse(gate.reason);
    }
    holdId = gate.holdId;

    // Create form data for OpenAI API
    const openAIFormData = new FormData();
    openAIFormData.append('file', audioFile);
    openAIFormData.append('model', 'whisper-1');
    // verbose_json returns the exact audio `duration` (seconds) OpenAI bills on, so
    // we charge real cost (duration × rate), not an approximation. Still has `.text`.
    openAIFormData.append('response_format', 'verbose_json');

    // Optionally set language for better accuracy
    if (language) {
      openAIFormData.append('language', language);
    }

    // Call OpenAI Whisper API
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAISettings.apiKey}`,
      },
      body: openAIFormData,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      loggers.ai.error('Whisper API error', new Error(JSON.stringify(errorData)), {
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
          error: 'Transcription failed',
          message: errorData.error?.message || 'Failed to transcribe audio',
        },
        { status: response.status }
      );
    }

    const result = await response.json();

    // Bill the real provider cost (audio seconds × published Whisper rate) against
    // the user's prepaid credits, with the standard markup applied downstream. This
    // settles the hold and releases it; trackUsage now owns the reservation.
    const seconds = typeof result.duration === 'number' ? result.duration : undefined;
    // verbose_json should always carry a duration; if it ever doesn't we'd bill $0
    // (free transcription). Surface it so the gap is observable instead of silent —
    // the usage row is also flagged (metadata.missingDuration) for the admin panel.
    if (seconds === undefined) {
      loggers.ai.warn('Whisper transcription returned no duration; billing $0 for this call', {
        userId,
        audioBytes: audioFile.size,
      });
    }
    const costDollars = calculateVoiceCostDollars('whisper-1', { seconds });
    holdHandedOff = true;
    await AIMonitoring.trackUsage({
      userId,
      provider: 'openai_voice',
      model: 'whisper-1',
      source: 'voice',
      providerCostDollars: costDollars,
      // Request latency (ms), matching the chat route — NOT the audio length, which
      // would pollute response-time analytics. Audio seconds (the billing quantity)
      // live in metadata.
      duration: Date.now() - startTime,
      success: true,
      holdId,
      // Deterministic list-price cost (audio seconds × published rate), not a live
      // provider-returned figure — labels the admin-panel coverage honestly.
      costSource: 'list_price',
      metadata: {
        type: 'voice_stt',
        audioBytes: audioFile.size,
        audioSeconds: seconds,
        ...(seconds === undefined ? { missingDuration: true } : {}),
      },
    });
    void emitCreditsUpdated(userId);

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'voice', resourceId: 'self', details: { operation: 'transcribe', audioSize: audioFile.size } });

    return NextResponse.json({
      text: result.text,
      duration: result.duration,
    });
  } catch (error) {
    loggers.ai.error('Voice transcription error', error as Error);
    return NextResponse.json(
      { error: 'Failed to transcribe audio' },
      { status: 500 }
    );
  } finally {
    if (holdId && !holdHandedOff) void releaseHold(holdId).catch(() => {});
  }
}
