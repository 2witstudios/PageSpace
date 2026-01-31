"use client";

import { memo, useCallback, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { useOpenTabsStore, selectHasMultipleTabs } from '@/stores/useOpenTabsStore';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { TabItem } from './TabItem';
import { cn } from '@/lib/utils';
import { getEffectiveBinding, matchesKeyEvent } from '@/stores/useHotkeyStore';

interface TabBarProps {
  className?: string;
}

export const TabBar = memo(function TabBar({ className }: TabBarProps) {
  const router = useRouter();
  const params = useParams();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isMobile = useBreakpoint('(max-width: 1023px)');

  const tabs = useOpenTabsStore((state) => state.tabs);
  const activeTabId = useOpenTabsStore((state) => state.activeTabId);
  const hasMultipleTabs = useOpenTabsStore(selectHasMultipleTabs);
  const setActiveTab = useOpenTabsStore((state) => state.setActiveTab);
  const closeTab = useOpenTabsStore((state) => state.closeTab);
  const closeOtherTabs = useOpenTabsStore((state) => state.closeOtherTabs);
  const closeTabsToRight = useOpenTabsStore((state) => state.closeTabsToRight);
  const pinTab = useOpenTabsStore((state) => state.pinTab);
  const unpinTab = useOpenTabsStore((state) => state.unpinTab);
  const cycleTab = useOpenTabsStore((state) => state.cycleTab);

  // Navigate when active tab changes
  const handleActivate = useCallback((tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (tab) {
      setActiveTab(tabId);
      router.push(`/dashboard/${tab.driveId}/${tab.id}`);
    }
  }, [tabs, setActiveTab, router]);

  // Handle close with navigation fallback
  const handleClose = useCallback((tabId: string) => {
    const tabIndex = tabs.findIndex(t => t.id === tabId);
    const isClosingActive = tabId === activeTabId;
    const remainingTabs = tabs.filter(t => t.id !== tabId);

    closeTab(tabId);

    // If closing active tab, navigate to the new active tab or dashboard
    if (isClosingActive) {
      if (remainingTabs.length > 0) {
        // Prefer the tab at the same index, or the last one
        const newActiveIndex = Math.min(tabIndex, remainingTabs.length - 1);
        const newActiveTab = remainingTabs[newActiveIndex];
        router.push(`/dashboard/${newActiveTab.driveId}/${newActiveTab.id}`);
      } else {
        // No tabs left, go to dashboard
        const driveId = params.driveId as string;
        router.push(`/dashboard${driveId ? `/${driveId}` : ''}`);
      }
    }
  }, [tabs, activeTabId, closeTab, router, params.driveId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cycle tabs
      if (matchesKeyEvent(getEffectiveBinding('tabs.cycle-next'), e)) {
        e.preventDefault();
        cycleTab('next');
        const newActiveTabId = useOpenTabsStore.getState().activeTabId;
        const newActiveTab = tabs.find(t => t.id === newActiveTabId);
        if (newActiveTab) {
          router.push(`/dashboard/${newActiveTab.driveId}/${newActiveTab.id}`);
        }
        return;
      }

      if (matchesKeyEvent(getEffectiveBinding('tabs.cycle-prev'), e)) {
        e.preventDefault();
        cycleTab('prev');
        const newActiveTabId = useOpenTabsStore.getState().activeTabId;
        const newActiveTab = tabs.find(t => t.id === newActiveTabId);
        if (newActiveTab) {
          router.push(`/dashboard/${newActiveTab.driveId}/${newActiveTab.id}`);
        }
        return;
      }

      // Tab number shortcuts (1-9)
      for (let num = 1; num <= 9; num++) {
        if (matchesKeyEvent(getEffectiveBinding(`tabs.go-to-${num}`), e)) {
          e.preventDefault();
          const index = num - 1;
          if (index < tabs.length) {
            const tab = tabs[index];
            handleActivate(tab.id);
          }
          return;
        }
      }

      // Close tab - skip in editable inputs
      const target = e.target as HTMLElement;
      const isInEditable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      if (!isInEditable && matchesKeyEvent(getEffectiveBinding('tabs.close'), e)) {
        if (activeTabId) {
          e.preventDefault();
          handleClose(activeTabId);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, activeTabId, handleActivate, handleClose, cycleTab, router]);

  // Scroll active tab into view
  useEffect(() => {
    if (!scrollContainerRef.current || !activeTabId) return;

    const container = scrollContainerRef.current;
    const activeElement = container.querySelector(`[aria-selected="true"]`);

    if (activeElement) {
      activeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
  }, [activeTabId]);

  // Auto-hide on mobile or when 0 or 1 tabs
  if (isMobile || !hasMultipleTabs) {
    return null;
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        className={cn(
          "flex-shrink-0 overflow-hidden",
          "bg-[oklch(0.35_0.08_235)] dark:bg-[oklch(0.20_0.06_235)]",
          "shadow-[inset_0_2px_4px_rgba(0,0,0,0.3),inset_0_1px_2px_rgba(0,0,0,0.2)]",
          className
        )}
      >
        <div
          ref={scrollContainerRef}
          role="tablist"
          aria-label="Open pages"
          className="flex items-stretch overflow-x-auto scrollbar-none"
        >
          {tabs.map((tab, index) => (
            <TabItem
              key={tab.id}
              tab={tab}
              index={index}
              isActive={tab.id === activeTabId}
              onActivate={handleActivate}
              onClose={handleClose}
              onCloseOthers={closeOtherTabs}
              onCloseToRight={closeTabsToRight}
              onPin={pinTab}
              onUnpin={unpinTab}
            />
          ))}
        </div>
      </motion.div>
    </AnimatePresence>
  );
});

export default TabBar;
