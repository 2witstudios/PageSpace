"use client";

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import { parseTabPath, getStaticTabMeta } from '@/lib/tabs/tab-title';
import { useDriveStore } from '@/hooks/useDrive';
import { fetchWithAuth } from '@/lib/auth/auth-fetch';
import { useTabsStore, type Tab } from '@/stores/useTabsStore';
import { isEditingActive } from '@/stores/useEditingStore';
import { PageType } from '@pagespace/lib/client-safe';

interface PageMetaResponse {
  id: string;
  title: string;
  type: PageType;
}

const PAGE_ICON_MAP: Record<PageType, string> = {
  DOCUMENT: 'FileText',
  AI_CHAT: 'MessageSquare',
  CANVAS: 'Layout',
  FILE: 'File',
  FOLDER: 'Folder',
  SHEET: 'Table',
  TASK_LIST: 'CheckSquare',
  CHANNEL: 'MessageSquare',
};

const fetcher = async (url: string): Promise<PageMetaResponse> => {
  const response = await fetchWithAuth(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status}`);
  }
  return response.json();
};

export interface UseTabMetaResult {
  title: string;
  iconName: string;
  pageType?: PageType;
  isLoading: boolean;
}

/**
 * Hook to get tab metadata (title, icon) from a tab.
 * For static routes, returns immediately.
 * For pages, reads cached title from tab or fetches and caches it.
 * For drives, reads from drive store.
 */
export function useTabMeta(tab: Tab): UseTabMetaResult {
  const parsed = parseTabPath(tab.path);
  const staticMeta = getStaticTabMeta(parsed);

  // Get drives from store for drive tab titles
  const drives = useDriveStore((state) => state.drives);
  const updateTabMeta = useTabsStore((state) => state.updateTabMeta);

  // Check if tab already has cached metadata for a page
  const hasCachedPageMeta = parsed.type === 'page' && parsed.pageId && tab.title;

  // Only fetch if it's a page without cached metadata
  const needsPageFetch = parsed.type === 'page' && parsed.pageId && !tab.title;
  const pageKey = needsPageFetch ? `/api/pages/${parsed.pageId}` : null;

  // UI refresh protection: pause revalidation during editing after initial load
  const hasLoadedRef = useRef(false);

  const { data: pageData, isLoading: isPageLoading, error: pageError } = useSWR<PageMetaResponse>(
    pageKey,
    fetcher,
    {
      isPaused: () => hasLoadedRef.current && isEditingActive(),
      onSuccess: () => { hasLoadedRef.current = true; },
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 60000,
    }
  );

  // Update tab metadata when page data is fetched
  useEffect(() => {
    if (pageData && parsed.pageId) {
      updateTabMeta(tab.id, {
        title: pageData.title || 'Untitled',
        pageType: pageData.type,
      });
    }
  }, [pageData, parsed.pageId, tab.id, updateTabMeta]);

  // Static routes - return immediately
  if (staticMeta) {
    return {
      title: staticMeta.title,
      iconName: staticMeta.iconName,
      isLoading: false,
    };
  }

  // Drive tab - get name from store
  if (parsed.type === 'drive' && parsed.driveId) {
    const drive = drives.find(d => d.id === parsed.driveId);
    return {
      title: drive?.name ?? 'Drive',
      iconName: 'LayoutDashboard',
      isLoading: false,
    };
  }

  // Page tab - use cached data from tab or fetched data
  if (parsed.type === 'page' && parsed.pageId) {
    // Return cached metadata from tab if available
    if (hasCachedPageMeta) {
      return {
        title: tab.title!,
        iconName: tab.pageType ? PAGE_ICON_MAP[tab.pageType] : 'File',
        pageType: tab.pageType,
        isLoading: false,
      };
    }

    // Return fetched data (will also trigger cache update via useEffect)
    if (pageData) {
      return {
        title: pageData.title || 'Untitled',
        iconName: PAGE_ICON_MAP[pageData.type] ?? 'File',
        pageType: pageData.type,
        isLoading: false,
      };
    }

    // Fetch failed or completed with no data - return stable fallback
    if (pageError || (!pageData && !isPageLoading)) {
      return {
        title: 'Untitled',
        iconName: 'File',
        isLoading: false,
      };
    }

    return {
      title: 'Loading...',
      iconName: 'File',
      isLoading: true,
    };
  }

  // Fallback
  return {
    title: tab.path,
    iconName: 'File',
    isLoading: false,
  };
}
