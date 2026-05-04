'use client';

import { memo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar, { type SidebarProps } from './index';
import DMSidebar from './DMSidebar';
import ChannelsSidebar from './ChannelsSidebar';

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders.
 * Each top-level nav item gets its own sidebar feed so the list is
 * always visible (mirrors PageTree always-on behavior in drive view).
 */
const MemoizedSidebar = memo((props: SidebarProps) => {
  const pathname = usePathname();

  if (pathname?.startsWith('/dashboard/dms')) {
    return <DMSidebar {...props} />;
  }

  if (pathname?.startsWith('/dashboard/channels')) {
    return <ChannelsSidebar {...props} />;
  }

  if (pathname && /^\/dashboard\/[^/]+\/channels(\/|$)/.test(pathname)) {
    return <ChannelsSidebar {...props} />;
  }

  return <Sidebar {...props} />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;
