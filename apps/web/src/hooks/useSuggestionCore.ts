import { useCallback, useRef } from 'react';
import { MentionSuggestion, MentionType } from '@/types/mentions';
import { suggestionApi, SuggestionApiError } from '@/services/suggestionService';
import { useSuggestionContext } from '@/components/providers/SuggestionProvider';

export interface SuggestionState {
  isOpen: boolean;
  items: MentionSuggestion[];
  selectedIndex: number;
  query: string;
  loading: boolean;
  error: SuggestionApiError | null;
}

export interface SuggestionConfig {
  driveId: string | null;
  allowedTypes: MentionType[];
  minQueryLength?: number;
  debounceMs?: number;
  crossDrive?: boolean; // Flag for cross-drive searches
}

export interface SuggestionCallbacks {
  onSelect: (suggestion: MentionSuggestion) => void;
  onClose?: () => void;
  onOpen?: () => void;
}

export interface UseSuggestionResult {
  state: SuggestionState;
  actions: {
    open: (query?: string) => void;
    close: () => void;
    setQuery: (query: string) => void;
    selectItem: (index: number) => void;
    selectSuggestion: (suggestion: MentionSuggestion) => void;
  };
}

export function useSuggestionCore(
  config: SuggestionConfig,
  callbacks: SuggestionCallbacks
): UseSuggestionResult {
  const context = useSuggestionContext();
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const currentRequestRef = useRef<string>('');

  const fetchSuggestions = useCallback(async (query: string) => {
    console.log('[useSuggestionCore] fetchSuggestions called with query:', query, 'minQueryLength:', config.minQueryLength ?? 2);
    
    if (query.length < (config.minQueryLength ?? 2)) {
      console.log('[useSuggestionCore] Query too short, clearing items');
      context.setItems([]);
      context.setLoading(false);
      context.setError(null);
      return;
    }

    if (!config.crossDrive && !config.driveId) {
      console.log('[useSuggestionCore] No driveId provided for within-drive search');
      context.setItems([]);
      context.setLoading(false);
      context.setError('Drive ID is required for within-drive search');
      return;
    }

    const requestId = `${Date.now()}-${Math.random()}`;
    currentRequestRef.current = requestId;

    console.log('[useSuggestionCore] Starting API request for query:', query, 'driveId:', config.driveId, 'crossDrive:', config.crossDrive);
    context.setLoading(true);
    context.setError(null);

    try {
      const result = await suggestionApi.fetchSuggestions(
        query,
        config.driveId,
        config.allowedTypes,
        config.crossDrive
      );

      console.log('[useSuggestionCore] API response:', result);

      if (currentRequestRef.current === requestId) {
        context.setItems(result.suggestions);
        context.setSelectedIndex(0);
        context.setLoading(false);
        context.setError(result.error ? result.error.message : null);
        console.log('[useSuggestionCore] Updated context with', result.suggestions.length, 'items');
      }
    } catch (error) {
      console.error('[useSuggestionCore] API request failed:', error);
      if (currentRequestRef.current === requestId) {
        context.setItems([]);
        context.setLoading(false);
        context.setError('Failed to fetch suggestions');
      }
    }
  }, [config.driveId, config.allowedTypes, config.minQueryLength, config.crossDrive, context]);

  const debouncedFetchSuggestions = useCallback((query: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      fetchSuggestions(query);
    }, config.debounceMs || 300);
  }, [fetchSuggestions, config.debounceMs]);

  const open = useCallback((initialQuery = '') => {
    console.log('[useSuggestionCore] open called with initialQuery:', initialQuery);
    debouncedFetchSuggestions(initialQuery);
    callbacks.onOpen?.();
  }, [debouncedFetchSuggestions, callbacks]);

  const close = useCallback(() => {
    context.close();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    currentRequestRef.current = '';
    callbacks.onClose?.();
  }, [callbacks, context]);

  const setQuery = useCallback((query: string) => {
    console.log('[useSuggestionCore] setQuery called with:', query);
    debouncedFetchSuggestions(query);
  }, [debouncedFetchSuggestions]);

  const selectItem = useCallback((index: number) => {
    if (index >= 0 && index < context.items.length) {
      context.setSelectedIndex(index);
    }
  }, [context]);

  const selectSuggestion = useCallback((suggestion: MentionSuggestion) => {
    callbacks.onSelect(suggestion);
    close();
  }, [callbacks, close]);

  return {
    state: {
      isOpen: context.isOpen,
      items: context.items,
      selectedIndex: context.selectedIndex,
      query: '',
      loading: context.loading,
      error: context.error ? { message: context.error } : null,
    },
    actions: {
      open,
      close,
      setQuery,
      selectItem,
      selectSuggestion,
    },
  };
}