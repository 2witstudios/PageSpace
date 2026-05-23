"use client";

import { useParams, usePathname } from 'next/navigation';

// Full-page routes that render their own content in the center panel
// (no GlobalAssistantView). The sidebar should show the chat tab for these.
const FULL_PAGE_ROUTE_PATTERN = /\/(activity|calendar|channels|connections|dms|drives|files|members|storage|tasks|trash|workflows)(\/|$)/;

/**
 * Hook to detect if we're on a "dashboard context" where GlobalAssistantView
 * is displayed in the middle panel.
 *
 * Dashboard context includes:
 * - /dashboard (main dashboard)
 * - /dashboard/[driveId] (drive root)
 *
 * NOT dashboard context:
 * - /dashboard/[driveId]/[pageId] (viewing a specific page)
 * - /dashboard/[driveId]/settings (settings pages)
 * - /dashboard/activity, /dashboard/trash, /dashboard/storage, /dashboard/connections (full-page routes)
 * - /dashboard/calendar, /dashboard/tasks, /dashboard/dms, /dashboard/channels (full-page routes)
 * - /dashboard/[driveId]/activity, /dashboard/[driveId]/trash, /dashboard/[driveId]/workflows (drive-level full-page routes)
 * - /dashboard/[driveId]/files, /dashboard/[driveId]/members, /dashboard/[driveId]/calendar, etc.
 */
export function useDashboardContext() {
  const params = useParams();
  const pathname = usePathname();

  // Full-page routes render their own content (no GlobalAssistantView),
  // so the sidebar should show the chat tab independently
  const isFullPageRoute = FULL_PAGE_ROUTE_PATTERN.test(pathname || '');

  // Dashboard context = no pageId in params, not on special routes, not on full-page routes
  const isDashboardContext = !params.pageId &&
    !pathname.endsWith('/settings') &&
    !pathname.endsWith('/settings/mcp') &&
    !isFullPageRoute;

  return { isDashboardContext };
}
