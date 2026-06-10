'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { positioningService, type Position } from '@/services/positioningService';
import {
  evaluateSlashTrigger,
  findSlashTrigger,
  buildCommandInsertion,
  type TokenRange,
} from '@/lib/commands/slash-trigger';
import {
  filterAndRankCommands,
  resolveSelectionTarget,
  type CommandSuggestionItem,
} from '@/lib/commands/command-picker-core';
import { resolvePickerKeyAction } from '@/lib/commands/picker-keyboard';
import { COMMAND_TOKEN_TYPE, type TrackedToken } from '@/lib/tokens/message-tokens';

export interface UseCommandSuggestionProps {
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Exposure gate (spec §0): when false the hook is inert and `/` stays literal. */
  enabled: boolean;
  driveId?: string;
  popupPlacement?: 'top' | 'bottom';
  /** One command per message: a tracked command chip blocks the trigger. */
  hasCommandToken: boolean;
  /** All tracked token ranges (a `/` inside an existing chip is not a trigger). */
  tokenRanges: readonly TokenRange[];
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
  query: string;
  selectedIndex: number;
  /** Run trigger detection for an input event (call after the value propagates). */
  handleInput: (value: string, inputType: string | null) => void;
  /** Navigation/selection keys while the picker is open (spec §1.7). */
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  /** Sync after programmatic value changes (clear, draft restore). Never opens. */
  syncDisplayText: (value: string) => void;
  actions: {
    select: (item: CommandSuggestionItem) => void;
    setSelectedIndex: (index: number) => void;
    close: () => void;
    dismiss: () => void;
  };
}

const FETCH_DEBOUNCE_MS = 200;
const FILTER_DEBOUNCE_MS = 200;

/**
 * Trigger-detection lifecycle for the universal `/` command picker.
 *
 * Mirrors the mention `useSuggestion` grammar (query extraction, Escape
 * dismissal memory, close-when-no-trigger, placement-aware keyboard nav) with
 * the spec §1.1 deltas: start-of-message only, one command per message, and
 * opening only on typing insertions (`InputEvent.inputType`), which the
 * mention hook's value-diffing cannot distinguish. State is hook-local — the
 * picker has no inner search input, so keyboard events flow through the
 * textarea and the hook owns the item list (unlike `MentionPickerPortal`,
 * which fetches behind an autofocused search field).
 */
export function useCommandSuggestion({
  inputRef,
  enabled,
  driveId,
  popupPlacement = 'top',
  hasCommandToken,
  tokenRanges,
  enterSelects,
  onValueChange,
  onTokenInserted,
}: UseCommandSuggestionProps): UseCommandSuggestionResult {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [allItems, setAllItems] = useState<CommandSuggestionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const prevValueRef = useRef('');
  const triggerIndexRef = useRef(-1);
  const dismissedTriggerRef = useRef(-1);
  const isComposingRef = useRef(false);
  const compositionStartValueRef = useRef('');
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchRequestRef = useRef(0);

  const closeInternal = useCallback(() => {
    setIsOpen(false);
    setPosition(null);
    setQuery('');
    setDebouncedQuery('');
    setSelectedIndex(0);
    if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
  }, []);

  const dismiss = useCallback(() => {
    dismissedTriggerRef.current = triggerIndexRef.current;
    closeInternal();
  }, [closeInternal]);

  const fetchCommands = useCallback(async () => {
    const requestId = ++fetchRequestRef.current;
    setLoading(true);
    const url = driveId
      ? `/api/commands/suggest?driveId=${encodeURIComponent(driveId)}`
      : '/api/commands/suggest';
    try {
      const response = await fetchWithAuth(url);
      const data: { suggestions?: CommandSuggestionItem[] } = await response.json();
      if (fetchRequestRef.current === requestId) {
        setAllItems(Array.isArray(data?.suggestions) ? data.suggestions : []);
      }
    } catch {
      if (fetchRequestRef.current === requestId) setAllItems([]);
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
      setDebouncedQuery(initialQuery);
      setSelectedIndex(0);
      setPosition(newPosition);
      setIsOpen(true);
      // Show the loading row immediately — the fetch is debounced, and an
      // empty-state flash ("No commands yet…") before it lands would mislead.
      setLoading(true);

      // Fetch the full resolvable list, debounced like the mention portal;
      // filtering against the typed query happens client-side (descriptions
      // are matched too, which the server's trigger-only q cannot do).
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        void fetchCommands();
      }, FETCH_DEBOUNCE_MS);
    },
    [inputRef, popupPlacement, fetchCommands]
  );

  const updateQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    // 200ms filter debounce, mirroring MentionPickerPortal's fetch debounce.
    filterDebounceRef.current = setTimeout(() => {
      setDebouncedQuery(nextQuery);
    }, FILTER_DEBOUNCE_MS);
  }, []);

  const evaluate = useCallback(
    (prevValue: string, value: string, inputType: string | null) => {
      const cursorPos = inputRef.current?.selectionStart ?? value.length;
      const result = evaluateSlashTrigger({
        prevValue,
        value,
        cursorPos,
        inputType,
        isComposing: isComposingRef.current,
        hasCommandToken,
        tokenRanges,
        isOpen,
        dismissedTriggerIndex: dismissedTriggerRef.current,
      });

      dismissedTriggerRef.current = result.dismissedTriggerIndex;

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
    [inputRef, hasCommandToken, tokenRanges, isOpen, open, updateQuery, closeInternal]
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
      // Programmatic changes (clear on send, draft restore, external pickers)
      // never open the picker, but they can invalidate an open one.
      if (isOpen) {
        const cursorPos = inputRef.current?.selectionStart ?? value.length;
        if (!findSlashTrigger(value, cursorPos, tokenRanges)) closeInternal();
      }
    },
    [isOpen, inputRef, tokenRanges, closeInternal]
  );

  const items = useMemo(
    () => filterAndRankCommands(allItems, debouncedQuery),
    [allItems, debouncedQuery]
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
        const hit = findSlashTrigger(value, cursorPos, tokenRanges);
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
    [inputRef, allItems, tokenRanges, onTokenInserted, onValueChange, closeInternal]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!enabled || !isOpen) return;

      const action = resolvePickerKeyAction(
        e.key,
        {
          placement: popupPlacement,
          selectedIndex,
          itemCount: items.length,
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
    [enabled, isOpen, popupPlacement, selectedIndex, items, enterSelects, select, dismiss]
  );

  // Clear pending timers on unmount (the picker also closes with the input).
  useEffect(() => {
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      if (filterDebounceRef.current) clearTimeout(filterDebounceRef.current);
    };
  }, []);

  return {
    isOpen,
    position,
    items,
    hasAnyCommands: allItems.length > 0,
    loading,
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
