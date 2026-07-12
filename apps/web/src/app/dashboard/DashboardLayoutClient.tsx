"use client";

import { usePathname } from "next/navigation";
import Layout from "@/components/layout/Layout";
import { PushNotificationManager } from "@/components/PushNotificationManager";
import { PushActionHandler } from "@/components/PushActionHandler";
import QuickCreatePalette from "@/components/create/QuickCreatePalette";
import { useHotkeyPreferences } from "@/hooks/useHotkeyPreferences";
import { useDesktopExchangeHandler } from "@/hooks/useDesktopExchangeHandler";
import { NonceProvider } from "@/contexts/NonceContext";

// Routes that render full-page content instead of CenterPanel
const FULL_PAGE_ROUTES = [
  '/dashboard/activity',
  '/dashboard/calendar',
  '/dashboard/channels',
  '/dashboard/connections',
  '/dashboard/development',
  '/dashboard/dms',
  '/dashboard/drives',
  '/dashboard/storage',
  '/dashboard/tasks',
  '/dashboard/trash',
];

export default function DashboardLayoutClient({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  const pathname = usePathname();

  useHotkeyPreferences();
  useDesktopExchangeHandler();

  // Check if current route should render its children directly
  // Also match /dashboard/[driveId]/activity pattern
  const isFullPageRoute = FULL_PAGE_ROUTES.some(route =>
    pathname === route || pathname?.startsWith(route + '/')
  ) || pathname?.match(/^\/dashboard\/[^/]+\/(activity|calendar|channels|development|files|tasks|trash|settings|members|workflows)/);


  return (
    <NonceProvider nonce={nonce}>
      <PushNotificationManager />
      <PushActionHandler />
      <QuickCreatePalette />
      {isFullPageRoute ? <Layout>{children}</Layout> : <Layout />}
    </NonceProvider>
  );
}
