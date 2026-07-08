'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { positioningService, type Position } from '@/services/positioningService';
import {
  evaluateSlashTrigger,
  findSlashTrigger,
  buildCommandInsertion,
  INITIAL_SLASH_MEMORY,
} from '@/lib/commands/slash-trigger';
import {
  filterAndRankCommands,
  resolveSelectionTarget,
  type CommandSuggestionItem,
} from '@/lib/commands/command-picker-core';
import { resolvePickerKeyAction } from '@/lib/commands/picker-keyboard';
import { COMMAND_TOKEN_TYPE, type TrackedToken } from '@/lib/tokens/message-tokens';
import { createClientLogger } from '@/lib/logging/client-logger';

const logger = createClientLogger({ namespace: 'commands', component: 'use-command-suggestion' });

export interface UseCommandSuggestionProps {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Exposure gate (spec §0): when false the hook is inert and `/` stays literal. */
  enabled: boolean;
  driveId?: string;
  popupPlacement?: 'top' | 'bottom';
  /**
   * Reads the live tracked-token list. A getter (not a prop value) so trigger
   * detection sees tokens the tracker updated synchronously earlier in the
   * same input event — e.g. a select-all-and-type-`/` edit that dissolves a
   * command chip and should immediately re-arm the trigger.
   */
  getTokens: () => readonly TrackedToken[];
  /** Whether Enter selects (hardware keyboard) or inserts a newline (mobile soft keyboard). */
  enterSelects: boolean;
  /** Propagates the new display text after chip insertion (tracker's handleDisplayTextChange). */
  onValueChange: (value: string) => void;
  /** Registers the inserted chip with the token tracker (call order mirrors mentions). */
  onTokenInserted: (token: TrackedToken) => void;
}

export interface UseCommandSuggestionResult {
  isOpen: boolean;
  position: Position | null;
  /** Filtered + ranked items currently shown. */
  items: CommandSuggestionItem[];
  /** Total resolvable commands (distinguishes the two empty states, spec §1.4). */
  hasAnyCommands: boolean;
  loading: boolean;
  /** True when the suggest fetch failed — the panel shows load-error copy. */
  loadFailed: boolean;
  query: string;
  selectedIndex: number;
  /** Run trigger detection for an input event (call after the value propagates). */
  handleInput: (value: string, inputType: string | null) => void;
  /** Navigation/selection keys while the picker is open (spec §1.7). */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  /** Sync after programmatic value changes (clear, draft restore). Never opens; closes if open. */
  syncDisplayText: (value: string) => void;
  actions: {
    select: (item: CommandSuggestionItem) => void;
    setSelectedIndex: (index: number) => void;
    close: () => void;
    dismiss: () => void;
  };
}

// Filtering against the typed query is debounced 200ms, mirroring the mention
// picker's fetch debounce (spec §1.4). The fetch itself fires immediately on
// open — it happens once per trigger, so there is nothing to coalesce.
const FILTER_DEBOUNCE_MS = 200;

/**
 * Trigger-detection lifecycle for the universal `/` command picker.
 *
 * Mirrors the mention `useSuggestion` grammar (query extraction, Escape
 * dismissal memory, close-when-no-trigger, placement-aware keyboard nav) with
 * the spec §1.1 deltas: trigger position mirrors the mention rule (mid-message
 * allowed, multiple command chips per message allowed — only an existing
 * chip's own tracked range excludes a fresh trigger) and opening only on
 * typing insertions (`InputEvent.inputType`), which the mention hook's
 * value-diffing cannot distinguish. State is hook-local — the
 * picker has no inner search input, so keyboard events flow through the
 * textarea and the hook owns the item list (unlike `MentionPickerPortal`,
 * which fetches behind an autofocused search field).
 */
export function useCommandSuggestion({
  inputRef,
  enabled,
  driveId,
  popupPlacement = 'top',
  getTokens,
  enterSelects,
  onValueChange,
  onTokenInserted,
}: UseCommandSuggestionProps): UseCommandSuggestionResult {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [query, setQuery] = useState('');
  // The query the list is actually filtered by. Seeded synchronously on open
  // (so the picker never shows a stale list filtered by a previous trigger's
  // query) and debounced 200ms while typing (spec §1.4).
  const [filterQuery, setFilterQuery] = useState('');
  const [allItems, setAllItems] = useState<CommandSuggestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // isOpen mirrored into a ref so the evaluate/handleInput callback chain
  // stays identity-stable across open/close (it is recreated otherwise, which
  // re-fires ChatTextarea's sync effect for nothing).
  const isOpenRef = useRef(false);
  const prevValueRef = useRef('');
  const triggerIndexRef = useRef(-1);
  const memoryRef = useRef(INITIAL_SLASH_MEMORY);
  const isComposingRef = useRef(false);
  const compositionStartValueRef = useRef('');
  const fetchRequestRef = useRef(0);
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeInternal = useCallback(() => {
    isOpenRef.current = false;
    setIsOpen(false);
    setPosition(null);
    setQuery('');
    setFilterQuery('');
    setSelectedIndex(0);
    // Drop the fetched list: a later reopen must not expose this trigger's
    // items (even invisibly behind the loading row) to Enter/Tab selection.
    // Bumping the request counter also invalidates any in-flight fetch so it
    // can't repopulate the list after the picker closed.
    fetchRequestRef.current++;
    setAllItems([]);
    setLoadFailed(false);
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
  }, []);

  const dismiss = useCallback(() => {
    memoryRef.current = {
      ...memoryRef.current,
      dismissedTriggerIndex: triggerIndexRef.current,
    };
    closeInternal();
  }, [closeInternal]);

  const fetchCommands = useCallback(async () => {
    const requestId = ++fetchRequestRef.current;
    setLoading(true);
    setLoadFailed(false);
    const url = driveId
      ? `/api/commands/suggest?driveId=${encodeURIComponent(driveId)}`
      : '/api/commands/suggest';
    try {
      const response = await fetchWithAuth(url);
      if (!response.ok) throw new Error(`suggest fetch failed: ${response.status}`);
      const data: { suggestions?: CommandSuggestionItem[] } = await response.json();
      if (fetchRequestRef.current === requestId) {
        setAllItems(Array.isArray(data?.suggestions) ? data.suggestions : []);
      }
    } catch (error) {
      logger.error('Failed to fetch command suggestions', { error, driveId });
      if (fetchRequestRef.current === requestId) {
        setAllItems([]);
        setLoadFailed(true);
      }
    } finally {
      if (fetchRequestRef.current === requestId) setLoading(false);
    }
  }, [driveId]);

  const open = useCallback(
    (triggerIndex: number, initialQuery: string) => {
      const element = inputRef.current;
      if (!element) return;

      const newPosition = positioningService.calculateTextareaPosition({
        element,
        textBeforeCursor: element.value.slice(0, element.selectionStart ?? 0),
        placement: popupPlacement,
      });

      triggerIndexRef.current = triggerIndex;
      setQuery(initialQuery);
      setFilterQuery(initialQuery);
      setSelectedIndex(0);
      setPosition(newPosition);
      isOpenRef.current = true;
      setIsOpen(true);
      void fetchCommands();
    },
    [inputRef, popupPlacement, fetchCommands]
  );

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => {
      setFilterQuery(nextQuery);
    }, FILTER_DEBOUNCE_MS);
  }, []);

  const evaluate = useCallback(
    (prevValue: string, value: string, inputType: string | null) => {
      const tokens = getTokens();
      const cursorPos = inputRef.current?.selectionStart ?? value.length;
      const result = evaluateSlashTrigger({
        prevValue,
        value,
        cursorPos,
        inputType,
        isComposing: isComposingRef.current,
        tokenRanges: tokens,
        isOpen: isOpenRef.current,
        memory: memoryRef.current,
      });

      memoryRef.current = result.memory;

      switch (result.action) {
        case 'open':
          open(result.triggerIndex, result.query);
          break;
        case 'update':
          triggerIndexRef.current = result.triggerIndex;
          updateQuery(result.query);
          break;
        case 'close':
          closeInternal();
          break;
        case 'none':
          break;
      }
    },
    [inputRef, getTokens, open, closeInternal]
  );

  const handleInput = useCallback(
    (value: string, inputType: string | null) => {
      if (!enabled) {
        prevValueRef.current = value;
        return;
      }
      const prevValue = prevValueRef.current;
      prevValueRef.current = value;
      evaluate(prevValue, value, inputType);
    },
    [enabled, evaluate]
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
    compositionStartValueRef.current = prevValueRef.current;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    if (!enabled) return;
    // Evaluate the committed composition once (spec §1.1): the whole composed
    // run counts as one typing insertion against the pre-composition value.
    const value = inputRef.current?.value ?? prevValueRef.current;
    const prevValue = compositionStartValueRef.current;
    prevValueRef.current = value;
    evaluate(prevValue, value, 'insertCompositionText');
  }, [enabled, inputRef, evaluate]);

  const syncDisplayText = useCallback(
    (value: string) => {
      if (value === prevValueRef.current) return;
      prevValueRef.current = value;
      // A programmatic replacement (clear on send, draft restore, toolbar
      // insertion) severs any relationship to the previously typed trigger:
      // reset the trigger memory so e.g. an Escape dismissal can't leak into
      // the next message, and close the picker — its query, anchor, and items
      // describe text the user is no longer typing.
      memoryRef.current = INITIAL_SLASH_MEMORY;
      if (isOpenRef.current) closeInternal();
    },
    [closeInternal]
  );

  const items = useMemo(
    () => filterAndRankCommands(allItems, filterQuery),
    [allItems, filterQuery]
  );

  // Keep the highlighted row valid as the filtered list changes.
  useEffect(() => {
    setSelectedIndex((current) => (current >= items.length ? 0 : current));
  }, [items.length]);

  const select = useCallback(
    (item: CommandSuggestionItem) => {
      const element = inputRef.current;
      if (!element) return;

      // Selecting a shadowed row inserts the winning command's chip (§1.6).
      const target = resolveSelectionTarget(allItems, item);

      const value = element.value;
      const cursorPos = element.selectionStart ?? value.length;
      let triggerIndex = triggerIndexRef.current;
      if (triggerIndex < 0 || value[triggerIndex] !== '/') {
        const hit = findSlashTrigger(value, cursorPos, getTokens());
        if (!hit) return;
        triggerIndex = hit.triggerIndex;
      }

      const insertion = buildCommandInsertion(value, triggerIndex, cursorPos, target.trigger);

      // Mirror the mention insertion order: register the token, then propagate
      // the value, then restore caret + focus (spec §2.1).
      onTokenInserted({
        start: insertion.token.start,
        end: insertion.token.end,
        label: target.trigger,
        id: target.id,
        type: COMMAND_TOKEN_TYPE,
      });
      onValueChange(insertion.newValue);
      prevValueRef.current = insertion.newValue;
      element.setSelectionRange(insertion.newCursorPos, insertion.newCursorPos);
      element.focus();
      closeInternal();
    },
    [inputRef, allItems, getTokens, onTokenInserted, onValueChange, closeInternal]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled || !isOpen) return;

      const action = resolvePickerKeyAction(
        e.key,
        {
          placement: popupPlacement,
          selectedIndex,
          // While loading the panel hides the list behind the spinner row, so
          // nothing is selectable — Enter falls through to send.
          itemCount: loading ? 0 : items.length,
          enterSelects,
        },
        { shiftKey: e.shiftKey }
      );

      switch (action.type) {
        case 'move':
          e.preventDefault();
          e.stopPropagation();
          setSelectedIndex(action.index);
          break;
        case 'select': {
          const item = items[selectedIndex];
          if (item) {
            e.preventDefault();
            e.stopPropagation();
            select(item);
          }
          break;
        }
        case 'dismiss':
          e.preventDefault();
          e.stopPropagation();
          dismiss();
          break;
        case 'none':
          break;
      }
    },
    [enabled, isOpen, popupPlacement, selectedIndex, items, loading, enterSelects, select, dismiss]
  );

  // Clear the pending filter timer on unmount.
  useEffect(() => {
    return () => {
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
  }, []);

  return {
    isOpen,
    position,
    items,
    hasAnyCommands: allItems.length > 0,
    loading,
    loadFailed,
    query,
    selectedIndex,
    handleInput,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
    syncDisplayText,
    actions: {
      select,
      setSelectedIndex,
      close: closeInternal,
      dismiss,
    },
  };
}
