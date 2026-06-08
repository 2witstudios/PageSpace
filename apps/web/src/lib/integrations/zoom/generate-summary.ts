import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';

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

    const result = await generateText({
      model: provider.model,
      system: SYSTEM_PROMPT,
      prompt: transcriptPlainText,
      maxOutputTokens: 512,
    });

    AIMonitoring.trackUsage({
      userId,
      provider: provider.provider,
      model: provider.modelName,
      source: 'integration',
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage
        ? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
        : undefined,
      success: true,
      metadata: { feature: 'zoom_summary' },
    });

    return result.text.trim();
  } catch (err) {
    loggers.api.warn('Zoom summary: generation failed', { error: err instanceof Error ? err.message : String(err) });
    return '';
  }
}
