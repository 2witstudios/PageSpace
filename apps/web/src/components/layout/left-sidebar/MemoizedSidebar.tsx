'use client';

import { memo } from 'react';
import { usePathname } from 'next/navigation';
import Sidebar from './index';
import MessagesLeftSidebar from './MessagesLeftSidebar';

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders
 * This helps avoid infinite loops in the layout system
 * Renders MessagesLeftSidebar when on messages route
 */
const MemoizedSidebar = memo(() => {
  const pathname = usePathname();
  const isMessagesRoute = pathname?.startsWith('/dashboard/messages');

  if (isMessagesRoute) {
    return <MessagesLeftSidebar />;
  }

  return <Sidebar />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;