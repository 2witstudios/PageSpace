"use client";

import { useParams, usePathname } from 'next/navigation';

/**
 * Hook to detect if we're on the dashboard or drive root where GlobalAssistantView
 * is displayed in the center panel and its state is shared with the sidebar.
 *
 * isDashboardContext = true ONLY at:
 * - /dashboard (main dashboard)
 * - /dashboard/[driveId] (drive root, no sub-route)
 *
 * All other routes (pages, full-page routes, settings, notifications, etc.) use
 * an independent sidebar chat and return isDashboardContext = false.
 */
export function useDashboardContext() {
  const params = useParams();
  const pathname = usePathname();

  // Normalize pathname to strip any trailing slash for consistent matching
  const normalizedPath = pathname?.replace(/\/$/, '') || '';

  // params.driveId distinguishes /dashboard/[driveId] from static routes like /dashboard/calendar
  const isDashboardContext =
    normalizedPath === '/dashboard' ||
    (!!params.driveId && !params.pageId && /^\/dashboard\/[^/]+$/.test(normalizedPath));

  return { isDashboardContext };
}
