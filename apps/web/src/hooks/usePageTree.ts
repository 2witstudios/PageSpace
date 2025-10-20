import useSWR, { useSWRConfig } from 'swr';
import { useState, useCallback } from 'react';
import { mergeChildren } from '@/lib/tree/tree-utils';
import { Page } from '@pagespace/lib/client';
import { fetchWithAuth } from '@/lib/auth-fetch';
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
};

const fetcher = async (url: string) => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export function usePageTree(driveId?: string, trashView?: boolean) {
  const swrKey = driveId ? (trashView ? `/api/drives/${encodeURIComponent(driveId)}/trash` : `/api/drives/${encodeURIComponent(driveId)}/pages`) : null;
  const { data, error, mutate } = useSWR<TreePage[]>(swrKey, fetcher);
  const { cache } = useSWRConfig();

  const [childLoadingMap, setChildLoadingMap] = useState<Record<string, boolean>>({});

  const fetchAndMergeChildren = useCallback(async (pageId: string) => {
    setChildLoadingMap(prev => ({ ...prev, [pageId]: true }));
    try {
      const children: TreePage[] = await fetcher(`/api/pages/${pageId}/children`);
      const currentTree = data || [];
      const updatedTree = mergeChildren(currentTree, pageId, children);
      mutate(updatedTree, false); // Optimistic update
    } catch (e) {
      console.error("Failed to fetch and merge children", e);
      // Optionally handle error, e.g., revert optimistic update or show a toast
    } finally {
      setChildLoadingMap(prev => ({ ...prev, [pageId]: false }));
    }
  }, [data, mutate]);

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

  const updateNode = (nodeId: string, updates: Partial<TreePage>) => {
    const update = (pages: TreePage[]): TreePage[] => {
      return pages.map(page => {
        if (page.id === nodeId) {
          return { ...page, ...updates, children: page.children || [] };
        }
        if (page.children && page.children.length > 0) {
          return { ...page, children: update(page.children) };
        }
        return { ...page, children: page.children || [] };
      });
    };

    mutate(update(data || []), false);
  };

  return {
    tree: data ?? [],
    isLoading: !error && !data,
    isError: error,
    mutate,
    updateNode,
    fetchAndMergeChildren,
    childLoadingMap,
    invalidateTree,
  };
}