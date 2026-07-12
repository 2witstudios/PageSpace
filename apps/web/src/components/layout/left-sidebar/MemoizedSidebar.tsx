'use client';

import { memo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar, { type SidebarProps } from './index';
import DMSidebar from './DMSidebar';
import ChannelsSidebar from './ChannelsSidebar';
import DevelopmentSidebar from './DevelopmentSidebar';
import { resolveSidebarVariant } from './sidebar-routes';

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders.
 * Each top-level nav item gets its own sidebar feed so the list is
 * always visible (mirrors PageTree always-on behavior in drive view).
 *
 * Which feed a pathname gets is decided by `resolveSidebarVariant` — this
 * component only maps that answer to a component.
 */
const MemoizedSidebar = memo((props: SidebarProps) => {
  const pathname = usePathname() ?? '';

  switch (resolveSidebarVariant(pathname)) {
    case 'dms':
      return <DMSidebar {...props} />;
    case 'channels':
      return <ChannelsSidebar {...props} />;
    case 'development':
      return <DevelopmentSidebar {...props} />;
    case 'default':
      return <Sidebar {...props} />;
  }
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;
