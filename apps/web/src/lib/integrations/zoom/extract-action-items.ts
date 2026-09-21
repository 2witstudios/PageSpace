import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring, discardUsageOutcome } from '@pagespace/lib/monitoring/ai-monitoring';
import { withZoomAiCredit } from './zoom-ai-credit';
import type { ActionItem } from './build-document';

const SYSTEM_PROMPT =
  'Extract action items from this meeting transcript. ' +
  'Return ONLY a JSON array of objects with shape { "text": string, "assignee"?: string }. ' +
  'Include the assignee name only when it is explicitly mentioned. ' +
  'Return an empty array if there are no action items. No explanation, just JSON.';

export async function extractActionItems(
  userId: string,
  transcriptPlainText: string
): Promise<ActionItem[]> {
  try {
    return await withZoomAiCredit(userId, 'zoom_action_items', () => extract(userId, transcriptPlainText), []);
  } catch (err) {
    loggers.api.warn('Zoom action items: extraction failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

async function extract(userId: string, transcriptPlainText: string): Promise<ActionItem[]> {
  const provider = await createAIProvider(userId, {});
  if (isProviderError(provider)) {
    loggers.api.warn('Zoom action items: AI provider unavailable', { userId, error: provider.error });
    return [];
  }

  const result = await generateText({
    model: provider.model,
    system: SYSTEM_PROMPT,
    prompt: transcriptPlainText,
    maxOutputTokens: 512,
  });

  discardUsageOutcome(AIMonitoring.trackUsage({
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
    metadata: { feature: 'zoom_action_items' },
  }));

  const jsonText = result.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  const parsed: unknown = JSON.parse(jsonText);

  if (!Array.isArray(parsed)) return [];

  // Model output is untrusted: narrow every entry before reading a field.
  return parsed.flatMap((item: unknown): ActionItem[] => {
    if (typeof item !== 'object' || item === null) return [];
    const { text, assignee } = item as Record<string, unknown>;
    if (typeof text !== 'string') return [];
    return [{ text, ...(typeof assignee === 'string' ? { assignee } : {}) }];
  });
}
