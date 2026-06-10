import { useRef, useCallback, useMemo } from 'react';
import {
  parseMessageTokens,
  serializeMessageTokens,
  updateTokenPositions,
  validTokensForText,
  COMMAND_TOKEN_TYPE,
  type TrackedToken,
} from '@/lib/tokens/message-tokens';
import type { TrackedMention } from '@/hooks/useMentionTracker';

export interface UseMessageTokensResult {
  /** Display text shown in the textarea (no IDs) */
  displayText: string;
  /** All tracked tokens (mentions + command chips) in the display text */
  tokens: TrackedToken[];
  /** Mention-type tokens only, for mention-specific consumers (useSuggestion ranges) */
  mentions: TrackedMention[];
  /** Whether any tokens exist (drives the transparent-text overlay mode) */
  hasTokens: boolean;
  /** One command per message: whether a command chip is currently tracked */
  hasCommandToken: boolean;
  /** Handle textarea text changes — updates positions and reports markdown to parent */
  handleDisplayTextChange: (newDisplayText: string) => void;
  /** Register a newly inserted token (call before handleDisplayTextChange) */
  registerToken: (token: TrackedToken) => void;
}

/**
 * Unified token tracker for chat inputs — the superset of `useMentionTracker`
 * that also tracks command chips (`/[Label](commandId:command)`) alongside
 * mentions (`@[Label](id:type)`). The mention behavior (parse, edit-region
 * position updates, overlap-dissolve, exact-text validation) is identical;
 * command chips ride the same machinery with a `/` sigil.
 */
export function useMessageTokens(
  markdownValue: string,
  onMarkdownChange: (markdown: string) => void
): UseMessageTokensResult {
  const displayTextRef = useRef('');
  const tokensRef = useRef<TrackedToken[]>([]);
  const lastReportedMarkdownRef = useRef('');
  const pendingTokensRef = useRef<TrackedToken[]>([]);

  // Parse markdown -> display text when value changes externally
  const { displayText, tokens } = useMemo(() => {
    // Skip re-parse if this value came from our own onChange
    if (markdownValue === lastReportedMarkdownRef.current) {
      return {
        displayText: displayTextRef.current,
        tokens: tokensRef.current,
      };
    }

    const parsed = parseMessageTokens(markdownValue);
    displayTextRef.current = parsed.displayText;
    tokensRef.current = parsed.tokens;
    return parsed;
  }, [markdownValue]);

  const registerToken = useCallback((token: TrackedToken) => {
    pendingTokensRef.current.push(token);
  }, []);

  const handleDisplayTextChange = useCallback(
    (newDisplayText: string) => {
      const oldDisplayText = displayTextRef.current;

      // Update existing token positions based on the text diff
      const updatedTokens = updateTokenPositions(
        tokensRef.current,
        oldDisplayText,
        newDisplayText
      );

      // Merge in pending tokens from suggestion selection
      const allTokens = [...updatedTokens, ...pendingTokensRef.current];
      pendingTokensRef.current = [];

      // Sort by position
      allTokens.sort((a, b) => a.start - b.start);

      // Validate token text still matches (safety check)
      const validTokens = validTokensForText(allTokens, newDisplayText);

      displayTextRef.current = newDisplayText;
      tokensRef.current = validTokens;

      // Convert to markdown and notify parent
      const markdown = serializeMessageTokens(newDisplayText, validTokens);
      lastReportedMarkdownRef.current = markdown;
      onMarkdownChange(markdown);
    },
    [onMarkdownChange]
  );

  const mentions = useMemo(
    () =>
      tokens.filter(
        (t): t is TrackedMention & TrackedToken => t.type !== COMMAND_TOKEN_TYPE
      ),
    [tokens]
  );

  const hasCommandToken = useMemo(
    () => tokens.some((t) => t.type === COMMAND_TOKEN_TYPE),
    [tokens]
  );

  return {
    displayText,
    tokens,
    mentions,
    hasTokens: tokens.length > 0,
    hasCommandToken,
    handleDisplayTextChange,
    registerToken,
  };
}
