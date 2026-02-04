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

  // Only show InboxSidebar when viewing a conversation (DM or channel)
  // The inbox list view uses the regular dashboard sidebar
  const isInboxConversation = pathname?.startsWith('/dashboard/inbox/dm/') ||
                              pathname?.startsWith('/dashboard/inbox/channel/');

  if (isInboxConversation) {
    return <InboxSidebar {...props} />;
  }

  return <Sidebar {...props} />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;
