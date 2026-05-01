import type { UIMessage } from 'ai';

type UIMessagePart = UIMessage['parts'][number];

/**
 * Runtime guard for incoming SSE part frames. The wire is trusted only
 * structurally: every UIMessagePart has a string `type` discriminator the
 * renderer branches on. A frame missing `type` (or with a non-string `type`)
 * cannot route to any renderer and would silently corrupt the parts array,
 * so it is dropped.
 *
 * Tool parts additionally require a `toolCallId` because that field is the
 * idempotency key inside `appendPart`'s replace-by-toolCallId branch — a
 * tool frame missing it would append duplicates instead of converging.
 *
 * Pure — no I/O, no side effects.
 */
export const isValidPartFrame = (raw: unknown): raw is UIMessagePart => {
  if (!raw || typeof raw !== 'object') return false;
  const part = raw as { type?: unknown; toolCallId?: unknown };
  if (typeof part.type !== 'string' || part.type.length === 0) return false;
  if (part.type.startsWith('tool-') && typeof part.toolCallId !== 'string') return false;
  return true;
};
