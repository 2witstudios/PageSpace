'use client';

import { memo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar, { type SidebarProps } from './index';
import MessagesLeftSidebar from './MessagesLeftSidebar';
import InboxSidebar from './InboxSidebar';

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders
 * This helps avoid infinite loops in the layout system
 * Routes to appropriate sidebar based on current path
 */
const MemoizedSidebar = memo((props: SidebarProps) => {
  const pathname = usePathname();
  const isMessagesRoute = pathname?.startsWith('/dashboard/messages');
  const isInboxRoute = pathname === '/dashboard/inbox' ||
                       pathname?.match(/^\/dashboard\/[^/]+\/inbox$/);

  if (isMessagesRoute) {
    return <MessagesLeftSidebar {...props} />;
  }

  if (isInboxRoute) {
    return <InboxSidebar {...props} />;
  }

  return <Sidebar {...props} />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;