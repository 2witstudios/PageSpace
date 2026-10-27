import { findEditRegion } from '@/lib/tokens/message-tokens';

/**
 * Pure state machine for the universal `/` command trigger (spec §1.1).
 *
 * Deltas from the mention trigger lifecycle in `useSuggestion`:
 *   - trigger position matches the mention rule exactly: `/` is valid at
 *     position 0 or immediately after whitespace, anywhere in the message,
 *     any number of times — the only exclusion is an existing tracked token
 *     range (a `/` inside an already-inserted chip is never a fresh trigger);
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
 * Mirrors the mention detection grammar: a `/` is a valid trigger at
 * position 0 or immediately after whitespace, anywhere in the message
 * (same rule as the `@` mention trigger in useSuggestion.ts).
 */
export function findSlashTrigger(
  value: string,
  cursorPos: number,
  tokenRanges: readonly TokenRange[] = []
): SlashTriggerHit | null {
  const textBeforeCursor = value.slice(0, cursorPos);

  // Find the start of the current "word" — the run of non-whitespace text
  // immediately before the cursor — rather than the nearest `/` to the
  // cursor. Anchoring on the nearest `/` would incorrectly invalidate a
  // still-valid earlier trigger whenever a second `/` appears later in the
  // same word (e.g. a path- or fraction-like query such as "/foo/bar", or
  // typing a stray `/` while a trigger's query is already in progress).
  let wordStart = 0;
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    if (/\s/.test(textBeforeCursor[i])) {
      wordStart = i + 1;
      break;
    }
  }

  // Mid-message rule: the current word is a valid trigger only when its
  // first character is `/` — position 0, or immediately after whitespace.
  if (textBeforeCursor[wordStart] !== '/') return null;
  const triggerIndex = wordStart;

  // The `/` may not sit inside an existing tracked token (e.g. a chip).
  if (tokenRanges.some((r) => triggerIndex >= r.start && triggerIndex < r.end)) {
    return null;
  }

  const query = textBeforeCursor.slice(triggerIndex + 1);

  // Trigger names cannot contain whitespace, so any whitespace in the query
  // ends the trigger (a space "completes" it, mirroring the mention close
  // pattern). This also guarantees the command picker is closed before a
  // mid-query `@` (preceded by a space) can open the mention picker — the two
  // pickers are never open at once.
  if (/\s/.test(query)) return null;
  // An already-serialized token after the `/` is not an active trigger.
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

/**
 * Trigger memory the caller threads between evaluations:
 * - `dismissedTriggerIndex`: the `/` the user dismissed via Escape — typing
 *   after it never reopens the picker (spec §1.1's dismissal memory).
 * - `typedTriggerIndex`: a `/` known to have arrived via a typing insertion —
 *   typing after it MAY reopen the picker after a non-Escape close (click
 *   outside), mirroring how the mention picker reopens on the next keystroke.
 *   A pasted `/` never earns this, so paste stays literal forever.
 *
 * Both reset to -1 the moment the trigger disappears ("deleting the `/` and
 * retyping it resets the dismissal").
 */
export interface SlashTriggerMemory {
  dismissedTriggerIndex: number;
  typedTriggerIndex: number;
}

export const INITIAL_SLASH_MEMORY: SlashTriggerMemory = {
  dismissedTriggerIndex: -1,
  typedTriggerIndex: -1,
};

export interface SlashEvaluationInput {
  prevValue: string;
  value: string;
  cursorPos: number;
  /** Native InputEvent.inputType for this change; null when unknown/programmatic. */
  inputType: string | null;
  isComposing: boolean;
  tokenRanges?: readonly TokenRange[];
  isOpen: boolean;
  memory: SlashTriggerMemory;
}

export type SlashEvaluation =
  | { action: 'open'; triggerIndex: number; query: string; memory: SlashTriggerMemory }
  | { action: 'update'; triggerIndex: number; query: string; memory: SlashTriggerMemory }
  | { action: 'close'; memory: SlashTriggerMemory }
  | { action: 'none'; memory: SlashTriggerMemory };

/**
 * Evaluate one input change against the slash-trigger rules.
 * The caller owns the state (isOpen, memory) and applies the returned action;
 * `memory` in the result is the new value to store.
 */
export function evaluateSlashTrigger(input: SlashEvaluationInput): SlashEvaluation {
  const {
    prevValue,
    value,
    cursorPos,
    inputType,
    isComposing,
    tokenRanges = [],
    isOpen,
    memory,
  } = input;

  const hit = findSlashTrigger(value, cursorPos, tokenRanges);

  if (!hit) {
    // Mirrors the mention close-when-no-trigger branch: the trigger is gone,
    // so both memories reset.
    return { action: isOpen ? 'close' : 'none', memory: INITIAL_SLASH_MEMORY };
  }

  if (isOpen) {
    // While open the trigger is by definition the legitimate typed one; if
    // its index shifted (e.g. leading whitespace edited), re-anchor the
    // typed-trigger memory so a later close→reopen still works.
    const nextMemory =
      memory.typedTriggerIndex === hit.triggerIndex
        ? memory
        : { ...memory, typedTriggerIndex: hit.triggerIndex };
    return { action: 'update', ...hit, memory: nextMemory };
  }

  // Opening requires typing: either this insertion placed the `/` itself, or
  // the user is typing after a `/` that previously arrived by typing (reopen
  // after a click-outside close — the mention-mirror behavior).
  const typing = !isComposing && isTypingInsertion(inputType);
  const editCoversTrigger = insertionCovers(prevValue, value, hit.triggerIndex);

  let nextMemory = memory;
  if (editCoversTrigger) {
    // The `/` at this index arrived in THIS edit: it is "typed" exactly when
    // the edit was a typing insertion. A paste that lands a `/` where a typed
    // one used to be must not inherit the typed status.
    nextMemory = { ...memory, typedTriggerIndex: typing ? hit.triggerIndex : -1 };
  }

  const triggerWasTyped = nextMemory.typedTriggerIndex === hit.triggerIndex;

  if (!typing || !triggerWasTyped) {
    return { action: 'none', memory: nextMemory };
  }
  if (nextMemory.dismissedTriggerIndex === hit.triggerIndex) {
    return { action: 'none', memory: nextMemory };
  }

  return { action: 'open', ...hit, memory: nextMemory };
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
