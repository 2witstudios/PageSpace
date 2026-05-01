import type { UIMessage } from 'ai';
import { mergeTextDeltas } from './mergeTextDeltas';

type AnyPart = UIMessage['parts'][number];

/**
 * Append a UIMessagePart to a parts array with shape-aware merge semantics.
 * Text parts delegate to `mergeTextDeltas` (positional concat). Tool parts
 * are keyed by `toolCallId` — re-applying the same id replaces (state
 * transitions input-available → output-available are convergent). Other part
 * types append as-is. Pure — never mutates input.
 */
// Stricter than message-utils.ts's `isToolInvocationPart` (which only checks
// the `tool-` prefix): we additionally require a string `toolCallId` because
// it is the merge key for the replace-by-toolCallId branch below — a tool
// part missing the id can't converge state transitions.
const isToolPart = (
  part: AnyPart,
): part is AnyPart & { type: `tool-${string}`; toolCallId: string } =>
  typeof part.type === 'string' &&
  part.type.startsWith('tool-') &&
  'toolCallId' in part &&
  typeof (part as { toolCallId?: unknown }).toolCallId === 'string';

export const appendPart = (
  parts: readonly AnyPart[],
  part: AnyPart,
): AnyPart[] => {
  if (part.type === 'text') {
    return mergeTextDeltas(parts, part);
  }
  if (isToolPart(part)) {
    const idx = parts.findIndex(
      (p) => isToolPart(p) && p.toolCallId === part.toolCallId,
    );
    if (idx >= 0) {
      const next = parts.slice();
      next[idx] = part;
      return next;
    }
  }
  return [...parts, part];
};
