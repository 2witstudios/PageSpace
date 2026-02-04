"use client";

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { X, Pin, File, FileText, LayoutDashboard, CheckSquare, Activity, Users, Settings, Trash2, MessageSquare, Layout, Folder, Table, Inbox, Calendar, HardDrive, Link, UserPlus, User, Bell, Shield, LifeBuoy, PenSquare } from 'lucide-react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import type { Tab } from '@/stores/useTabsStore';
import { parseTabPath } from '@/lib/tabs/tab-title';
import { useTabMeta } from '@/hooks/useTabMeta';
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

// Map icon names to components
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  CheckSquare,
  Activity,
  Users,
  Settings,
  Trash2,
  MessageSquare,
  File,
  FileText,
  Layout,
  Folder,
  Table,
  Inbox,
  Calendar,
  HardDrive,
  Link,
  UserPlus,
  User,
  Bell,
  Shield,
  LifeBuoy,
  PenSquare,
};

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
  // Get title and icon from tab (cached metadata or fetch if needed)
  const tabMeta = useTabMeta(tab);

  // Extract pageId from path for dirty state check (if it's a page)
  const pageId = useMemo(() => {
    const parsed = parseTabPath(tab.path);
    return parsed.pageId;
  }, [tab.path]);

  const isDirty = useDirtyStore((state) => pageId ? state.isDirty(pageId) : false);

  // Drag and drop sortable
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  };

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
          {...attributes}
          {...listeners}
          ref={setNodeRef}
          style={style}
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
              ? "bg-white/15 text-white"
              : "text-white/70 hover:bg-white/10 hover:text-white",
            tab.isPinned && "min-w-0 max-w-[60px] px-2",
            isDragging && "shadow-lg ring-2 ring-primary/50"
          )}
        >
          {/* Tab icon - use static icon from meta or PageTypeIcon for pages */}
          {(() => {
            const IconComponent = ICON_MAP[tabMeta.iconName];
            if (IconComponent) {
              return <IconComponent className="h-3.5 w-3.5 flex-shrink-0 text-white" />;
            }
            // Fallback to PageTypeIcon for page types (shouldn't happen with current icon map)
            return (
              <PageTypeIcon
                type={tabMeta.pageType ?? PageType.DOCUMENT}
                className="h-3.5 w-3.5 flex-shrink-0 text-white"
              />
            );
          })()}

          {/* Title (hidden for pinned tabs) */}
          {!tab.isPinned && (
            <span className="truncate flex-1 text-left">
              {tabMeta.title}
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
              aria-label={`Close ${tabMeta.title}`}
            >
              <X className="h-3 w-3" />
            </button>
          )}

          {/* Active tab indicator - uses primary color to contrast with both dark trough and white content */}
          {isActive && (
            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary dark:bg-primary" />
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
