import useSWR, { useSWRConfig } from 'swr';
import { useState, useCallback, useRef, useEffect } from 'react';
import { mergeChildren } from '@/lib/tree/tree-utils';
import { Page } from '@pagespace/lib/client';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useEditingStore } from '@/stores/useEditingStore';

type User = {
  id: string;
  name: string | null;
  image: string | null;
};

type ChatMessage = {
  id: string;
  content: string;
  createdAt: Date;
  role: 'user' | 'assistant';
  userId: string | null;
  pageId: string;
  toolCalls: unknown;
  toolResults: unknown;
};

type AiChat = {
  id: string;
  model: string;
  pageId: string;
  providerOverride?: string;
  temperature?: number;
  systemPrompt?: string;
};

export type MessageWithUser = ChatMessage & { user: User | null };
export type TreePage = Page & {
  children: TreePage[];
  aiChat: AiChat | null;
  messages: MessageWithUser[];
  isTaskLinked?: boolean;
  hasChanges?: boolean;
};

const FETCH_TIMEOUT_MS = 15000; // 15 second timeout for page tree requests

const fetcher = async (url: string) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetchWithAuth(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`Failed to fetch: ${response.status}`);
      (error as Error & { status: number }).status = response.status;
      throw error;
    }
    return response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('Page tree request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

export function usePageTree(driveId?: string, trashView?: boolean) {
  const swrKey = driveId ? (trashView ? `/api/drives/${encodeURIComponent(driveId)}/trash` : `/api/drives/${encodeURIComponent(driveId)}/pages`) : null;
  const { data, error, mutate, isValidating } = useSWR<TreePage[]>(
    swrKey,
    fetcher,
    {
      // Retry failed requests up to 3 times with increasing delay
      errorRetryCount: 3,
      errorRetryInterval: 2000,
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
    }
  );
  const { cache } = useSWRConfig();

  // Self-healing: detect when SWR gets stuck (valid key, no data, no error, not fetching).
  // On desktop/Capacitor, async token retrieval in fetchWithAuth can cause SWR to lose track
  // of in-flight fetches during React re-renders from auth state settling. When stuck, we
  // perform the same cache.delete + mutate that the manual retry button does.
  const stuckRetryCount = useRef(0);

  useEffect(() => {
    stuckRetryCount.current = 0;
  }, [swrKey]);

  useEffect(() => {
    if (!swrKey || data || error || isValidating) return;
    if (stuckRetryCount.current >= 2) return;

    const timeoutId = setTimeout(() => {
      stuckRetryCount.current += 1;
      console.log(`[usePageTree] SWR appears stuck — auto-retrying (${stuckRetryCount.current}/2)`);
      cache.delete(swrKey);
      mutate();
    }, 3000);

    return () => clearTimeout(timeoutId);
  }, [swrKey, data, error, isValidating, cache, mutate]);

  const [childLoadingMap, setChildLoadingMap] = useState<Record<string, boolean>>({});

  const fetchAndMergeChildren = useCallback(async (pageId: string) => {
    setChildLoadingMap(prev => ({ ...prev, [pageId]: true }));
    try {
      const children: TreePage[] = await fetcher(`/api/pages/${pageId}/children`);
      mutate((currentData) => {
        const currentTree = currentData || [];
        return mergeChildren(currentTree, pageId, children);
      }, { revalidate: false }); // Optimistic update
    } catch (e) {
      console.error("Failed to fetch and merge children", e);
      // Optionally handle error, e.g., revert optimistic update or show a toast
    } finally {
      setChildLoadingMap(prev => ({ ...prev, [pageId]: false }));
    }
  }, [mutate]);

  const invalidateTree = useCallback(() => {
    if (swrKey) {
      // Don't revalidate tree if user is actively editing to prevent component remounting
      // Allow revalidation during AI streaming to show real-time updates
      const isEditing = useEditingStore.getState().isAnyEditing();
      if (isEditing) {
        console.log('⏸️ Skipping tree revalidation - document editing in progress');
        return;
      }

      cache.delete(swrKey);
      mutate(); // Re-fetch
    }
  }, [swrKey, cache, mutate]);

  const updateNode = useCallback((nodeId: string, updates: Partial<TreePage>) => {
    mutate((currentData) => {
      if (!currentData) return currentData;

      let found = false;

      const update = (pages: TreePage[]): TreePage[] => {
        const newPages = pages.map(page => {
          if (page.id === nodeId) {
            found = true;
            return { ...page, ...updates, children: page.children || [] };
          }

          if (page.children && page.children.length > 0) {
            const newChildren = update(page.children);
            if (newChildren !== page.children) {
              return { ...page, children: newChildren };
            }
          }
          return page;
        });

        const hasChanged = newPages.some((newPage, i) => newPage !== pages[i]);
        return hasChanged ? newPages : pages;
      };

      const newTree = update(currentData);
      return found ? newTree : currentData;
    }, { revalidate: false });
  }, [mutate]);

  // User-initiated retry: bypasses the editing guard (unlike invalidateTree)
  // because the user explicitly chose to retry, so we should always honor it.
  const retry = useCallback(() => {
    if (swrKey) {
      cache.delete(swrKey);
      mutate();
    }
  }, [swrKey, cache, mutate]);

  return {
    tree: data ?? [],
    isLoading: !error && !data && !!driveId,
    isError: error,
    isValidating,
    mutate,
    updateNode,
    fetchAndMergeChildren,
    childLoadingMap,
    invalidateTree,
    retry,
  };
}
