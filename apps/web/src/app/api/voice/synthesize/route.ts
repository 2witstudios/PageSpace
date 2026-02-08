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
import { getUserOpenAISettings } from '@/lib/ai/core/ai-utils';
import { loggers } from '@pagespace/lib/server';

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
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get OpenAI API key
    const openAISettings = await getUserOpenAISettings(userId);
    if (!openAISettings?.apiKey) {
      return NextResponse.json(
        {
          error: 'OpenAI API key required',
          message: 'Voice mode requires an OpenAI API key. Please configure it in Settings > AI.',
        },
        { status: 400 }
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
  }
}
