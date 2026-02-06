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
  // Track if initial data has been loaded to avoid blocking first fetch
  const hasLoadedRef = useRef(false);

  // Reset loaded status when driveId or trashView changes to ensure fresh pages can load even during editing
  useEffect(() => {
    hasLoadedRef.current = false;
  }, [driveId, trashView]);

  const swrKey = driveId ? (trashView ? `/api/drives/${encodeURIComponent(driveId)}/trash` : `/api/drives/${encodeURIComponent(driveId)}/pages`) : null;
  const { data, error, mutate, isValidating } = useSWR<TreePage[]>(
    swrKey,
    fetcher,
    {
      // Only pause revalidation after initial load - never block the first fetch
      // Use isAnyEditing() to allow tree updates during AI streaming (not just isEditingActive/isAnyActive)
      isPaused: () => hasLoadedRef.current && useEditingStore.getState().isAnyEditing(),
      onSuccess: () => {
        hasLoadedRef.current = true;
      },
      // Retry failed requests up to 3 times with increasing delay
      errorRetryCount: 3,
      errorRetryInterval: 2000,
      // Don't revalidate automatically after error - let user retry manually
      revalidateOnFocus: false,
      revalidateOnReconnect: true,
    }
  );
  const { cache } = useSWRConfig();

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
