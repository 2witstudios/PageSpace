/**
 * Debug utilities for tracking render loops and performance issues
 */
import React from 'react';

interface RenderTracker {
  count: number;
  lastRender: number;
  component: string;
}

const renderTrackers = new Map<string, RenderTracker>();

export function trackRender(componentName: string, threshold: number = 50) {
  const now = Date.now();
  const tracker = renderTrackers.get(componentName) || {
    count: 0,
    lastRender: now,
    component: componentName
  };
  
  tracker.count++;
  
  // Reset count if it's been more than 5 seconds since last render
  if (now - tracker.lastRender > 5000) {
    tracker.count = 1;
  }
  
  tracker.lastRender = now;
  renderTrackers.set(componentName, tracker);
  
  // Log warning if we're rendering too frequently
  if (tracker.count > threshold) {
    console.warn(`🚨 Potential infinite loop detected in ${componentName}:`, {
      renderCount: tracker.count,
      threshold,
      timeSpan: '5 seconds'
    });
    
    // Log stack trace to help identify the cause
    console.trace(`Render trace for ${componentName}`);
    
    return true; // Indicates potential loop
  }
  
  // Log normal render activity in development
  if (process.env.NODE_ENV === 'development' && tracker.count % 10 === 0) {
    console.log(`📊 ${componentName} render count: ${tracker.count}`);
  }
  
  return false;
}

export function getRenderStats() {
  const stats = Array.from(renderTrackers.entries()).map(([name, tracker]) => ({
    component: name,
    renderCount: tracker.count,
    lastRender: new Date(tracker.lastRender).toLocaleTimeString()
  }));
  
  return stats.sort((a, b) => b.renderCount - a.renderCount);
}

export function clearRenderStats() {
  renderTrackers.clear();
}

export function logRenderStats() {
  console.table(getRenderStats());
}

/**
 * React hook to track component renders
 */
export function useRenderTracker(componentName: string, threshold?: number) {
  const hasLoop = trackRender(componentName, threshold);
  
  if (hasLoop) {
    console.error(`Infinite loop detected in ${componentName}, consider:
    1. Checking useEffect dependencies
    2. Removing store subscriptions from effect dependencies
    3. Using useCallback/useMemo for expensive operations
    4. Checking if state updates are causing re-renders`);
  }
  
  return hasLoop;
}

/**
 * Higher-order component to add render tracking
 */
export function withRenderTracker<P extends object>(
  Component: React.ComponentType<P>,
  componentName?: string
) {
  const TrackedComponent = (props: P): React.ReactElement => {
    const name = componentName || Component.displayName || Component.name || 'Unknown';
    useRenderTracker(name);
    return React.createElement(Component, props);
  };
  
  TrackedComponent.displayName = `withRenderTracker(${Component.displayName || Component.name})`;
  
  return TrackedComponent;
}