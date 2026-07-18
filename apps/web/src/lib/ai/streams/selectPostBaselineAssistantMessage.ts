import type { RenderedMessage } from './selectRenderedMessages';

export interface PostBaselineAssistantMessage {
  id: string;
  text: string;
}

/**
 * The latest SETTLED (non-streaming) assistant message worth speaking, or
 * null when there's nothing new since the voice-activation baseline (epic
 * leaf 6.4). Streaming rows are always excluded — VoiceCallPanel speaks a
 * live stream via its own `streamingText` prop; publishing partial text here
 * too would double-speak it.
 */
export const selectPostBaselineAssistantMessage = (
  renderedMessages: readonly RenderedMessage[],
  baselineId: string | null,
): PostBaselineAssistantMessage | null => {
  const settled = renderedMessages.filter((r) => r.mode !== 'streaming');
  const lastAssistant = [...settled].reverse().find((r) => r.message.role === 'assistant');
  if (!lastAssistant) return null;
  if (lastAssistant.message.id === baselineId) return null;

  const text = (lastAssistant.message.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; text: string }).text)
    .join('');
  if (!text.trim()) return null;

  return { id: lastAssistant.message.id, text };
};
