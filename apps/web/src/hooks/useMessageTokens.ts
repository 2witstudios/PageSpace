import { useRef, useCallback, useMemo } from 'react';
import {
  parseMessageTokens,
  serializeMessageTokens,
  updateTokenPositions,
  validTokensForText,
  type TrackedToken,
} from '@/lib/tokens/message-tokens';

// Stable identity for the no-token case — the common path for most messages.
// Keeping the same array across keystrokes prevents dependency churn in the
// suggestion hooks that receive the token list.
const EMPTY_TOKENS: TrackedToken[] = [];

export interface UseMessageTokensResult {
  /** Display text shown in the textarea (no IDs) */
  displayText: string;
  /** All tracked tokens (mentions + command chips) in the display text */
  tokens: TrackedToken[];
  /** Whether any tokens exist (drives the transparent-text overlay mode) */
  hasTokens: boolean;
  /**
   * Stable getter for the live token list. Event handlers that run after the
   * tracker has synchronously processed the same input event (e.g. slash
   * trigger detection) read through this instead of render-captured props.
   */
  getTokens: () => readonly TrackedToken[];
  /** Handle textarea text changes — updates positions and reports markdown to parent */
  handleDisplayTextChange: (newDisplayText: string) => void;
  /** Register a newly inserted token (call before handleDisplayTextChange) */
  registerToken: (token: TrackedToken) => void;
}

/**
 * Unified token tracker for chat inputs — the superset of the mention tracker
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
  const tokensRef = useRef<TrackedToken[]>(EMPTY_TOKENS);
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
    tokensRef.current = parsed.tokens.length === 0 ? EMPTY_TOKENS : parsed.tokens;
    return { displayText: parsed.displayText, tokens: tokensRef.current };
  }, [markdownValue]);

  const registerToken = useCallback((token: TrackedToken) => {
    pendingTokensRef.current.push(token);
  }, []);

  const getTokens = useCallback((): readonly TrackedToken[] => tokensRef.current, []);

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
      const pending = pendingTokensRef.current;
      pendingTokensRef.current = [];

      let validTokens: TrackedToken[];
      if (updatedTokens.length === 0 && pending.length === 0) {
        // Hot path: no tokens before or after — keep the stable empty array.
        validTokens = EMPTY_TOKENS;
      } else {
        const allTokens = [...updatedTokens, ...pending];
        allTokens.sort((a, b) => a.start - b.start);
        // Validate token text still matches (safety check)
        validTokens = validTokensForText(allTokens, newDisplayText);
        if (validTokens.length === 0) validTokens = EMPTY_TOKENS;
      }

      displayTextRef.current = newDisplayText;
      tokensRef.current = validTokens;

      // Convert to markdown and notify parent
      const markdown = serializeMessageTokens(newDisplayText, validTokens);
      lastReportedMarkdownRef.current = markdown;
      onMarkdownChange(markdown);
    },
    [onMarkdownChange]
  );

  return {
    displayText,
    tokens,
    hasTokens: tokens.length > 0,
    getTokens,
    handleDisplayTextChange,
    registerToken,
  };
}
