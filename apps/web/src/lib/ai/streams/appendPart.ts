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
export const appendPart = (
  parts: readonly AnyPart[],
  part: AnyPart,
): AnyPart[] => {
  if (part.type === 'text') {
    return mergeTextDeltas(parts, part);
  }
  return [...parts, part];
};
