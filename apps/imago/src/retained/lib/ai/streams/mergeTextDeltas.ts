import type { UIMessage } from 'ai';

type AnyPart = UIMessage['parts'][number];
type TextPart = Extract<AnyPart, { type: 'text' }>;

/**
 * Append a text-delta part to a parts array. If the last part is also text,
 * concatenate; otherwise push as a new part. Pure — never mutates input.
 */
export const mergeTextDeltas = (
  parts: readonly AnyPart[],
  textPart: TextPart,
): AnyPart[] => {
  const last = parts[parts.length - 1];
  if (last && last.type === 'text') {
    return [
      ...parts.slice(0, -1),
      { ...last, text: last.text + textPart.text },
    ];
  }
  return [...parts, textPart];
};
