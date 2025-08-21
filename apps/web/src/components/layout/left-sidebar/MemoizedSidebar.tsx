'use client';

import { memo } from 'react';
import Sidebar from './index';

/**
 * Memoized version of Sidebar to prevent unnecessary re-renders
 * This helps avoid infinite loops in the layout system
 */
const MemoizedSidebar = memo(() => {
  return <Sidebar />;
});

MemoizedSidebar.displayName = 'MemoizedSidebar';

export default MemoizedSidebar;