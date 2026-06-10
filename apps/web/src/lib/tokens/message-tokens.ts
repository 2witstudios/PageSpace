import type { MentionType } from '@/types/mentions';

/**
 * Unified inline-token model for chat inputs.
 *
 * Two token kinds share one serialization grammar:
 *   - mentions:  `@[Label](id:type)`   (type = page | user | everyone | role)
 *   - commands:  `/[Label](commandId:command)`
 *
 * This module is the pure core behind `useMessageTokens` — parsing markdown to
 * display text, tracking token positions through edits (the original mention
 * tracker's overlap-dissolve model, which this superseded), and serializing
 * back. Mention-only behavior is identical to the old tracker's.
 */

export const COMMAND_TOKEN_TYPE = 'command' as const;

export type TokenType = MentionType | typeof COMMAND_TOKEN_TYPE;

export interface TrackedToken {
  start: number;
  end: number;
  label: string;
  id: string;
  type: TokenType;
}

/** A tracked token that is a mention (the pre-command tracker's public shape). */
export interface TrackedMention extends Omit<TrackedToken, 'type'> {
  type: MentionType;
}

/** Sigil shown in the textarea before the label: '@' for mentions, '/' for commands. */
export function tokenSigil(type: TokenType): '@' | '/' {
  return type === COMMAND_TOKEN_TYPE ? '/' : '@';
}

/** Exact display text a token occupies in the textarea. */
export function tokenDisplayText(label: string, type: TokenType): string {
  return `${tokenSigil(type)}${label}`;
}

// Same shape as the mention regex with the sigil generalized to [@/].
const TOKEN_REGEX = /([@/])\[([^\]]+)\]\(([^:]+):([^)]+)\)/g;

/**
 * Parse markdown-typed token format into display text and tracked positions.
 *
 * Input:  "/[foo](c1:command) hi @[Alice](u1:user)"
 * Output: { displayText: "/foo hi @Alice", tokens: [...] }
 *
 * A '/'-sigil match whose type is not `command` is left as literal text —
 * only the exact command serialization produces a chip.
 */
export function parseMessageTokens(markdown: string): {
  displayText: string;
  tokens: TrackedToken[];
} {
  const tokens: TrackedToken[] = [];
  let displayText = '';
  let lastIndex = 0;

  TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TOKEN_REGEX.exec(markdown)) !== null) {
    const [fullMatch, sigil, label, id, type] = match;

    // Sigil and type must agree: only `/...:command` is a command and only
    // `@...:<mention type>` is a mention. A mismatched pair (e.g. literal
    // text "@[x](y:command)") stays plain text — chipping it would flip its
    // sigil on re-serialization.
    const isCommand = sigil === '/';
    if (isCommand !== (type === COMMAND_TOKEN_TYPE)) {
      displayText += markdown.slice(lastIndex, match.index) + fullMatch;
      lastIndex = match.index + fullMatch.length;
      continue;
    }

    displayText += markdown.slice(lastIndex, match.index);

    const tokenStart = displayText.length;
    const display = `${sigil}${label}`;
    displayText += display;

    tokens.push({
      start: tokenStart,
      end: tokenStart + display.length,
      label,
      id,
      type: isCommand ? COMMAND_TOKEN_TYPE : (type as MentionType),
    });

    lastIndex = match.index + fullMatch.length;
  }

  displayText += markdown.slice(lastIndex);

  return { displayText, tokens };
}

/**
 * Convert display text + tracked tokens back to markdown-typed format.
 */
export function serializeMessageTokens(
  displayText: string,
  tokens: TrackedToken[]
): string {
  if (tokens.length === 0) return displayText;

  const sorted = [...tokens].sort((a, b) => a.start - b.start);

  let markdown = '';
  let lastIndex = 0;

  for (const token of sorted) {
    markdown += displayText.slice(lastIndex, token.start);
    markdown += `${tokenSigil(token.type)}[${token.label}](${token.id}:${token.type})`;
    lastIndex = token.end;
  }

  markdown += displayText.slice(lastIndex);

  return markdown;
}

/**
 * Find the edit region between old and new text.
 * Returns the range in old text that was replaced and the corresponding range in new text.
 */
export function findEditRegion(
  oldText: string,
  newText: string
): { start: number; oldEnd: number; newEnd: number } {
  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText[start] === newText[start]
  ) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText[oldEnd - 1] === newText[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  return { start, oldEnd, newEnd };
}

/**
 * Update token positions after a text edit.
 * Removes tokens that overlap the edited region (the chip dissolves into plain
 * text) and shifts those after it.
 */
export function updateTokenPositions(
  tokens: TrackedToken[],
  oldText: string,
  newText: string
): TrackedToken[] {
  // Identity-stable for the hot no-token path (every keystroke in every chat
  // input goes through here).
  if (tokens.length === 0) return tokens;

  const { start, oldEnd, newEnd } = findEditRegion(oldText, newText);
  const delta = (newEnd - start) - (oldEnd - start);

  return tokens
    .filter((t) => {
      // Remove tokens that overlap with the edited region in old text
      return !(t.start < oldEnd && t.end > start);
    })
    .map((t) => {
      if (t.start >= oldEnd) {
        // Shift tokens after the edit
        return { ...t, start: t.start + delta, end: t.end + delta };
      }
      return t;
    });
}

/**
 * Keep only tokens whose display text still matches exactly (safety check —
 * a dissolved or manually re-typed token never silently re-chips).
 */
export function validTokensForText(
  tokens: TrackedToken[],
  text: string
): TrackedToken[] {
  return tokens.filter(
    (t) => text.slice(t.start, t.end) === tokenDisplayText(t.label, t.type)
  );
}
