'use client';

import { memo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar, { type SidebarProps } from './index';
import DMSidebar from './DMSidebar';
import ChannelsSidebar from './ChannelsSidebar';

const DMS_PATH = /^\/dashboard\/dms(\/|$)/;
const CHANNELS_PATH = /^\/dashboard\/channels(\/|$)/;
const DRIVE_CHANNELS_PATH = /^\/dashboard\/[^/]+\/channels(\/|$)/;

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders.
 * Each top-level nav item gets its own sidebar feed so the list is
 * always visible (mirrors PageTree always-on behavior in drive view).
 */
const MemoizedSidebar = memo((props: SidebarProps) => {
  const pathname = usePathname() ?? '';

  if (DMS_PATH.test(pathname)) {
    return <DMSidebar {...props} />;
  }

  if (CHANNELS_PATH.test(pathname) || DRIVE_CHANNELS_PATH.test(pathname)) {
    return <ChannelsSidebar {...props} />;
  }

  return <Sidebar {...props} />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;
