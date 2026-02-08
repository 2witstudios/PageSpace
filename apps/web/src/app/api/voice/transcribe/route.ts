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
import { getUserOpenAISettings } from '@/lib/ai/core/ai-utils';
import { loggers } from '@pagespace/lib/server';

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

    // Create form data for OpenAI API
    const openAIFormData = new FormData();
    openAIFormData.append('file', audioFile);
    openAIFormData.append('model', 'whisper-1');
    openAIFormData.append('response_format', 'json');

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
  }
}
