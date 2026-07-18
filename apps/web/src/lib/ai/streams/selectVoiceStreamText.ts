import type { RenderedMessage } from './selectRenderedMessages';

/**
 * Joined text parts of the conversation's live streaming row (selectRenderedMessages
 * output), or null when nothing is streaming. Replaces the 3x-duplicated
 * "last message while displayIsStreaming" derivation (epic leaf 6.4).
 */
export const selectVoiceStreamText = (renderedMessages: readonly RenderedMessage[]): string | null => {
  const last = renderedMessages[renderedMessages.length - 1];
  if (!last || last.mode !== 'streaming') return null;
  return (last.message.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; text: string }).text)
    .join('');
};
