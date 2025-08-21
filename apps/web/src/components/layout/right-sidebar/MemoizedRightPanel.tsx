'use client';

import { memo } from 'react';
import RightPanel from './index';

/**
 * Memoized version of RightPanel to prevent unnecessary re-renders
 * This helps avoid infinite loops in the layout system
 */
const MemoizedRightPanel = memo(() => {
  return <RightPanel />;
});

MemoizedRightPanel.displayName = 'MemoizedRightPanel';

export default MemoizedRightPanel;