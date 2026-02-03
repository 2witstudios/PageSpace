"use client";

import { usePathname } from "next/navigation";
import Layout from "@/components/layout/Layout";
import { useHotkeyPreferences } from "@/hooks/useHotkeyPreferences";

// Routes that render full-page content instead of CenterPanel
const FULL_PAGE_ROUTES = [
  '/dashboard/activity',
  '/dashboard/connections',
  '/dashboard/inbox',
  '/dashboard/storage',
  '/dashboard/tasks',
  '/dashboard/trash',
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Load user hotkey preferences and sync to store
  useHotkeyPreferences();

  // Check if current route should render its children directly
  // Also match /dashboard/[driveId]/activity pattern
  const isFullPageRoute = FULL_PAGE_ROUTES.some(route =>
    pathname?.startsWith(route)
  ) || pathname?.match(/^\/dashboard\/[^/]+\/(activity|inbox|tasks|trash|settings|members)/);

  if (isFullPageRoute) {
    return <Layout>{children}</Layout>;
  }

  // Default: Dashboard pages return null, CenterPanel handles content
  return <Layout />;
}

