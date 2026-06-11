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

  const isDashboardContext =
    pathname === '/dashboard' ||
    (!params.pageId && /^\/dashboard\/[^/]+$/.test(pathname || ''));

  return { isDashboardContext };
}
