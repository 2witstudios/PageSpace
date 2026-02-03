'use client';

import { memo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar, { type SidebarProps } from './index';
import InboxSidebar from './InboxSidebar';

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders
 * This helps avoid infinite loops in the layout system
 * Routes to appropriate sidebar based on current path
 */
const MemoizedSidebar = memo((props: SidebarProps) => {
  const pathname = usePathname();

  // Check if on inbox routes (including dm and channel sub-routes)
  const isInboxRoute = pathname === '/dashboard/inbox' ||
                       pathname?.startsWith('/dashboard/inbox/') ||
                       pathname?.match(/^\/dashboard\/[^/]+\/inbox$/);

  // Legacy messages route - redirect to inbox
  const isMessagesRoute = pathname?.startsWith('/dashboard/messages');

  if (isInboxRoute || isMessagesRoute) {
    return <InboxSidebar {...props} />;
  }

  return <Sidebar {...props} />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;