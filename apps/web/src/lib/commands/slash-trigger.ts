import { findEditRegion } from '@/lib/tokens/message-tokens';

/**
 * Pure state machine for the universal `/` command trigger (spec §1.1).
 *
 * Deltas from the mention trigger lifecycle in `useSuggestion`:
 *   - `/` triggers only at the start of the message (position 0 or preceded
 *     only by whitespace), one command per message;
 *   - the picker opens only when a *typing insertion* (keystroke or committed
 *     IME composition, per `InputEvent.inputType`) places the `/` at the
 *     trigger position — paste/drop/autofill stay literal;
 *   - everything else (query extraction, close-when-no-trigger, Escape
 *     dismissal memory) mirrors the mention behavior.
 */

export interface SlashTriggerHit {
  triggerIndex: number;
  query: string;
}

export interface TokenRange {
  start: number;
  end: number;
}

/**
 * Find the active `/` trigger for the current value + cursor, or null.
 * Mirrors the mention detection grammar with the start-of-message constraint.
 */
export function findSlashTrigger(
  value: string,
  cursorPos: number,
  tokenRanges: readonly TokenRange[] = []
): SlashTriggerHit | null {
  const textBeforeCursor = value.slice(0, cursorPos);
  const triggerIndex = textBeforeCursor.search(/\S/);

  // Start-of-message rule: the first non-whitespace character before the
  // cursor must be the `/` itself.
  if (triggerIndex === -1 || textBeforeCursor[triggerIndex] !== '/') return null;

  // The `/` may not sit inside an existing tracked token (e.g. a chip).
  if (tokenRanges.some((r) => triggerIndex >= r.start && triggerIndex < r.end)) {
    return null;
  }

  const query = textBeforeCursor.slice(triggerIndex + 1);

  // Mirrors the mention "completed mention" patterns: a finished word plus
  // whitespace, or an already-serialized token, means the `/` is no longer an
  // active trigger.
  if (/^[^\s[\]]+\s/.test(query)) return null;
  if (/^\[[^\]]+\]\([^)]+\)/.test(query)) return null;

  return { triggerIndex, query };
}

/**
 * A typing insertion is a keystroke or committed IME composition — the only
 * input kinds that may open the picker (spec §1.1). Paste, drop, autofill,
 * replacements, and deletions never open it.
 */
export function isTypingInsertion(inputType: string | null | undefined): boolean {
  return inputType === 'insertText' || inputType === 'insertCompositionText';
}

/**
 * Whether the edit from prevValue → value inserted text covering `index` —
 * i.e. the character at `index` arrived in this edit.
 */
export function insertionCovers(
  prevValue: string,
  value: string,
  index: number
): boolean {
  const { start, newEnd } = findEditRegion(prevValue, value);
  return index >= start && index < newEnd;
}

export interface SlashEvaluationInput {
  prevValue: string;
  value: string;
  cursorPos: number;
  /** Native InputEvent.inputType for this change; null when unknown/programmatic. */
  inputType: string | null;
  isComposing: boolean;
  /** One command per message: true when a command chip is already tracked. */
  hasCommandToken: boolean;
  tokenRanges?: readonly TokenRange[];
  isOpen: boolean;
  /** Index of the `/` the user dismissed via Escape; -1 = none. */
  dismissedTriggerIndex: number;
}

export type SlashEvaluation =
  | { action: 'open'; triggerIndex: number; query: string; dismissedTriggerIndex: number }
  | { action: 'update'; triggerIndex: number; query: string; dismissedTriggerIndex: number }
  | { action: 'close'; dismissedTriggerIndex: number }
  | { action: 'none'; dismissedTriggerIndex: number };

/**
 * Evaluate one input change against the slash-trigger rules.
 * The caller owns the state (isOpen, dismissedTriggerIndex) and applies the
 * returned action; `dismissedTriggerIndex` in the result is the new value to
 * store (it resets to -1 when the trigger disappears, mirroring mentions).
 */
export function evaluateSlashTrigger(input: SlashEvaluationInput): SlashEvaluation {
  const {
    prevValue,
    value,
    cursorPos,
    inputType,
    isComposing,
    hasCommandToken,
    tokenRanges = [],
    isOpen,
    dismissedTriggerIndex,
  } = input;

  if (hasCommandToken) {
    return { action: isOpen ? 'close' : 'none', dismissedTriggerIndex };
  }

  const hit = findSlashTrigger(value, cursorPos, tokenRanges);

  if (!hit) {
    // Mirrors the mention close-when-no-trigger branch, which also resets
    // the Escape-dismissal memory.
    return { action: isOpen ? 'close' : 'none', dismissedTriggerIndex: -1 };
  }

  if (isOpen) {
    return { action: 'update', ...hit, dismissedTriggerIndex };
  }

  // Opening requires a typing insertion that placed the `/` itself.
  if (isComposing) return { action: 'none', dismissedTriggerIndex };
  if (!isTypingInsertion(inputType)) return { action: 'none', dismissedTriggerIndex };
  if (!insertionCovers(prevValue, value, hit.triggerIndex)) {
    return { action: 'none', dismissedTriggerIndex };
  }
  if (dismissedTriggerIndex === hit.triggerIndex) {
    return { action: 'none', dismissedTriggerIndex };
  }

  return { action: 'open', ...hit, dismissedTriggerIndex };
}

export interface CommandInsertion {
  newValue: string;
  /** Display-text range of the inserted chip (`/trigger`). */
  token: TokenRange;
  /** Caret position after the chip's trailing space. */
  newCursorPos: number;
}

/**
 * Build the insertion for a selected command: replace from the `/` to the
 * cursor with `/trigger` plus a trailing space (mirrors the mention
 * `appendSpace` behavior), keeping any text after the cursor.
 */
export function buildCommandInsertion(
  value: string,
  triggerIndex: number,
  cursorPos: number,
  trigger: string
): CommandInsertion {
  const display = `/${trigger}`;
  const before = value.slice(0, triggerIndex);
  const after = value.slice(cursorPos);
  return {
    newValue: `${before}${display} ${after}`,
    token: { start: triggerIndex, end: triggerIndex + display.length },
    newCursorPos: triggerIndex + display.length + 1,
  };
}
