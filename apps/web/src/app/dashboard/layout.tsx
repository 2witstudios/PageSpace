"use client";

import { usePathname } from "next/navigation";
import Layout from "@/components/layout/Layout";

// Routes that render full-page content instead of CenterPanel
const FULL_PAGE_ROUTES = [
  '/dashboard/activity',
  '/dashboard/connections',
  '/dashboard/messages',
  '/dashboard/storage',
  '/dashboard/trash',
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Check if current route should render its children directly
  // Also match /dashboard/[driveId]/activity pattern
  const isFullPageRoute = FULL_PAGE_ROUTES.some(route =>
    pathname?.startsWith(route)
  ) || pathname?.match(/^\/dashboard\/[^/]+\/(activity|trash|settings|members)/);

  if (isFullPageRoute) {
    return <Layout>{children}</Layout>;
  }

  // Default: Dashboard pages return null, CenterPanel handles content
  return <Layout />;
}

