import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Builds a minimal assistant `UIMessage` from a stream's accumulated parts
 * array. Used by surfaces that synthesize the in-flight remote stream as a
 * real assistant message bubble (so MessageRenderer + ToolCallRenderer
 * render identically to the originator's view).
 *
 * When `startedAt` (the stream's ISO start time) is provided, it is attached
 * as a `createdAt` Date so the bubble carries a timestamp footer that matches
 * its persisted neighbors. It is omitted entirely when absent or unparseable,
 * so a synthesized bubble degrades to today's timestamp-less behavior rather
 * than rendering an `Invalid Date`.
 *
 * `status` (epic leaf 6.8, D ixpwr76xepu2x9v4pxgksyhz) is set only on the
 * onStreamComplete replace-in-place call sites — 'interrupted' or 'complete'
 * — so a browser tab with the conversation OPEN at the moment its stream
 * ends shows the interrupted badge immediately, without waiting for the next
 * reload. Omitted (not set to undefined) for the live-streaming synthesis
 * call sites, which have no terminal status yet — same "omit rather than
 * set undefined" convention as `createdAt`.
 *
 * Pure — never mutates the input parts array.
 */
export const synthesizeAssistantMessage = (
  messageId: string,
  parts: readonly UIMessagePart[],
  startedAt?: string,
  status?: 'complete' | 'interrupted',
): UIMessage & { createdAt?: Date; status?: 'complete' | 'interrupted' } => {
  const createdAt = startedAt ? new Date(startedAt) : undefined;
  const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined;
  return {
    id: messageId,
    role: 'assistant',
    parts: [...parts],
    ...(validCreatedAt ? { createdAt: validCreatedAt } : {}),
    ...(status ? { status } : {}),
  };
};
