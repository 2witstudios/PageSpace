'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Hook for navigating to pages that works correctly in both web and Electron.
 *
 * In web, `/p/${pageId}` routes use server-side redirects with cookie-based auth.
 * In Electron, auth is stored in secure storage (not cookies), so we need to
 * resolve the driveId client-side before navigating to `/dashboard/${driveId}/${pageId}`.
 */
export function usePageNavigation() {
  const router = useRouter();

  /**
   * Navigate to a page. If driveId is provided, navigates directly.
   * If not, falls back to `/p/${pageId}` on web or fetches driveId on Electron.
   */
  const navigateToPage = useCallback(async (pageId: string, driveId?: string) => {
    // If we have driveId, navigate directly
    if (driveId) {
      router.push(`/dashboard/${driveId}/${pageId}`);
      return;
    }

    // Check if we're in Electron
    const isDesktop = typeof window !== 'undefined' && window.electron?.isDesktop;

    if (!isDesktop) {
      // Web: use the server-side redirect route (works with cookie auth)
      router.push(`/p/${pageId}`);
      return;
    }

    // Electron: fetch the driveId from API first
    try {
      const response = await fetch(`/api/pages/${pageId}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        // If we can't fetch the page, fall back to /p/ route
        // (this will likely redirect to signin, but at least shows an error)
        console.warn('[usePageNavigation] Failed to fetch page info, falling back to /p/ route');
        router.push(`/p/${pageId}`);
        return;
      }

      const page = await response.json();

      if (page.driveId) {
        router.push(`/dashboard/${page.driveId}/${pageId}`);
      } else {
        // Shouldn't happen, but fallback just in case
        router.push(`/p/${pageId}`);
      }
    } catch (error) {
      console.error('[usePageNavigation] Error fetching page info:', error);
      // Fallback to /p/ route on error
      router.push(`/p/${pageId}`);
    }
  }, [router]);

  return { navigateToPage };
}
