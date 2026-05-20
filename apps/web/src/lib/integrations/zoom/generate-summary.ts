import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/logging/logger-config';

const SYSTEM_PROMPT =
  'Summarize this meeting transcript in 3–5 bullet points. Focus on decisions made and key outcomes. Be concise.';

export async function generateTranscriptSummary(
  userId: string,
  transcriptPlainText: string
): Promise<string> {
  try {
    const provider = await createAIProvider(userId, {});
    if (isProviderError(provider)) {
      loggers.api.warn('Zoom summary: AI provider unavailable', { userId, error: provider.error });
      return '';
    }

    const { text } = await generateText({
      model: provider.model,
      system: SYSTEM_PROMPT,
      prompt: transcriptPlainText,
      maxOutputTokens: 512,
    });

    return text.trim();
  } catch (err) {
    loggers.api.warn('Zoom summary: generation failed', { error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}
