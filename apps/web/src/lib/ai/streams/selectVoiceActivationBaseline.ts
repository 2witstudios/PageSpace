import type { RenderedMessage } from './selectRenderedMessages';

/**
 * The assistant message id to baseline voice mode against on activation
 * (epic leaf 6.4) — pre-existing messages are never spoken, only genuinely
 * new replies. If a stream is mid-flight at activation time, the baseline is
 * the PREVIOUSLY-finalized assistant message (the in-progress one is not
 * "old", it just hasn't spoken yet); otherwise it's the last assistant
 * message (nothing new until a future reply).
 */
export const selectVoiceActivationBaseline = (renderedMessages: readonly RenderedMessage[]): string | null => {
  const assistantRows = renderedMessages.filter((r) => r.message.role === 'assistant');
  const last = assistantRows[assistantRows.length - 1];
  const baselineIdx = last?.mode === 'streaming' ? assistantRows.length - 2 : assistantRows.length - 1;
  return assistantRows[baselineIdx]?.message.id ?? null;
};
