import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
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

    AIMonitoring.trackUsage({
      userId,
      provider: provider.provider,
      model: provider.modelName,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      totalTokens: result.usage
        ? (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0)
        : undefined,
      success: true,
      metadata: { feature: 'zoom_action_items' },
    });

    const jsonText = result.text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonText);

    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is ActionItem => typeof item?.text === 'string')
      .map((item) => ({
        text: item.text,
        ...(typeof item.assignee === 'string' ? { assignee: item.assignee } : {}),
      }));
  } catch (err) {
    loggers.api.warn('Zoom action items: extraction failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}
