"use client";

import { useParams, usePathname } from 'next/navigation';

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
 */
export function useDashboardContext() {
  const params = useParams();
  const pathname = usePathname();

  // Dashboard context = no pageId in params and not on special settings routes
  const isDashboardContext = !params.pageId &&
    !pathname.endsWith('/settings') &&
    !pathname.endsWith('/settings/mcp');

  return { isDashboardContext };
}
