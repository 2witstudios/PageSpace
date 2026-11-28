import type { TextSize } from './text-size-preference';

/** The slice of <html> a choice writes to; tests pass a plain object. */
type TextSizeTarget = {
  readonly dataset: Record<string, string | undefined>;
};

/**
 * Writes the size onto `data-text-size`, which scales the root font size in
 * globals.css; every type token is rem, so all text follows in place. The
 * server renders it from the cookie, so this only runs on a choice.
 */
export const applyTextSize = (root: TextSizeTarget, size: TextSize): void => {
  root.dataset.textSize = size;
};
