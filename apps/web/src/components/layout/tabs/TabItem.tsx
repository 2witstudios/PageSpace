"use client";

import { memo, useCallback } from 'react';
import { X, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PageTypeIcon } from '@/components/common/PageTypeIcon';
import { useDirtyStore } from '@/stores/useDirtyStore';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { Tab } from '@/stores/useOpenTabsStore';
import { PageType } from '@pagespace/lib/client-safe';

interface TabItemProps {
  tab: Tab;
  index: number;
  isActive: boolean;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCloseOthers: (tabId: string) => void;
  onCloseToRight: (tabId: string) => void;
  onPin: (tabId: string) => void;
  onUnpin: (tabId: string) => void;
}

export const TabItem = memo(function TabItem({
  tab,
  index,
  isActive,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onPin,
  onUnpin,
}: TabItemProps) {
  const isDirty = useDirtyStore((state) => state.isDirty(tab.id));

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onActivate(tab.id);
  }, [tab.id, onActivate]);

  const handleMiddleClick = useCallback((e: React.MouseEvent) => {
    // Only handle middle-click (button 1), not right-click
    if (e.button !== 1) return;
    e.preventDefault();
    onClose(tab.id);
  }, [tab.id, onClose]);

  const handleCloseClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onClose(tab.id);
  }, [tab.id, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onActivate(tab.id);
    }
  }, [tab.id, onActivate]);

  // Show keyboard shortcut number for first 9 tabs
  const shortcutNumber = index < 9 ? index + 1 : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="tab"
          aria-selected={isActive}
          tabIndex={isActive ? 0 : -1}
          onClick={handleClick}
          onAuxClick={handleMiddleClick}
          onKeyDown={handleKeyDown}
          className={cn(
            "group relative flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium cursor-pointer",
            "transition-colors duration-100",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white",
            "max-w-[180px] min-w-[100px]",
            isActive
              ? "bg-white/20 text-white"
              : "text-white/80 hover:bg-white/10 hover:text-white",
            tab.isPinned && "min-w-0 max-w-[60px] px-2"
          )}
        >
          {/* Page type icon */}
          <PageTypeIcon
            type={tab.type as PageType}
            className="h-3.5 w-3.5 flex-shrink-0 text-white"
          />

          {/* Title (hidden for pinned tabs) */}
          {!tab.isPinned && (
            <span className="truncate flex-1 text-left">
              {tab.title}
            </span>
          )}

          {/* Dirty indicator or shortcut number */}
          {isDirty ? (
            <span
              className="h-2 w-2 rounded-full bg-amber-500 flex-shrink-0"
              title="Unsaved changes"
            />
          ) : shortcutNumber && !tab.isPinned ? (
            <span className="text-[10px] text-white/70 flex-shrink-0 hidden group-hover:inline">
              {shortcutNumber}
            </span>
          ) : null}

          {/* Pin indicator for pinned tabs */}
          {tab.isPinned && (
            <Pin className="h-3 w-3 text-white/80 flex-shrink-0" />
          )}

          {/* Close button (not shown for pinned tabs) */}
          {!tab.isPinned && (
            <button
              type="button"
              onClick={handleCloseClick}
              className={cn(
                "ml-1 rounded-sm p-0.5 flex-shrink-0",
                "opacity-0 group-hover:opacity-100 focus:opacity-100",
                "hover:bg-white/20 text-white transition-opacity",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              )}
              aria-label={`Close ${tab.title}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}

          {/* Active tab indicator */}
          {isActive && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white" />
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent className="w-48">
        <ContextMenuItem onClick={() => onClose(tab.id)}>
          Close
          <span className="ml-auto text-xs text-muted-foreground">Ctrl+W</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCloseOthers(tab.id)}>
          Close Others
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onCloseToRight(tab.id)}>
          Close to the Right
        </ContextMenuItem>
        <ContextMenuSeparator />
        {tab.isPinned ? (
          <ContextMenuItem onClick={() => onUnpin(tab.id)}>
            Unpin Tab
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onClick={() => onPin(tab.id)}>
            Pin Tab
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});
