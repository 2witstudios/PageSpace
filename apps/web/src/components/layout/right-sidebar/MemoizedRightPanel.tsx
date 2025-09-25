'use client';

import { memo } from 'react';
import RightPanel, { type RightPanelProps } from './index';

/**
 * Memoized version of RightPanel to prevent unnecessary re-renders
 * This helps avoid infinite loops in the layout system
 */
const MemoizedRightPanel = memo((props: RightPanelProps) => {
  return <RightPanel {...props} />;
});

MemoizedRightPanel.displayName = 'MemoizedRightPanel';

export default MemoizedRightPanel;