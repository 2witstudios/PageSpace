"use client";

import { useState, useCallback, useMemo, CSSProperties, MouseEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTabsStore } from "@/stores/useTabsStore";
import { shouldOpenInNewTab } from "@/lib/tabs/tab-navigation-utils";
import {
  ChevronRight,
  ExternalLink,
  FolderPlus,
  Plus,
  Trash2,
  Pencil,
  Star,
  Undo2,
  CheckSquare,
  FolderInput,
  Copy,
} from "lucide-react";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { TreePage } from "@/hooks/usePageTree";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Checkbox } from "@/components/ui/checkbox";
import { useFavorites } from "@/hooks/useFavorites";
import { toast } from "sonner";
import { DeletePageDialog } from "@/components/dialogs/DeletePageDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { MovePageDialog } from "@/components/dialogs/MovePageDialog";
import { CopyPageDialog } from "@/components/dialogs/CopyPageDialog";
import { patch, del, post } from "@/lib/auth/auth-fetch";
import { Projection } from "@/lib/tree/sortable-tree";
import { cn } from "@/lib/utils";
import { useSortable } from "@dnd-kit/sortable";
import { useMultiSelectStore, SelectedPageInfo } from "@/stores/useMultiSelectStore";

export type DropPosition = "before" | "after" | "inside" | null;

interface HandleProps {
  ref: (element: HTMLElement | null) => void;
  listeners: ReturnType<typeof useSortable>["listeners"];
  attributes: ReturnType<typeof useSortable>["attributes"];
}

interface WrapperProps {
  ref: (element: HTMLElement | null) => void;
  style: CSSProperties;
}

export interface PageTreeItemProps {
  item: TreePage;
  depth: number;
  isActive: boolean;
  isOver: boolean;
  dropPosition: DropPosition;
  projectedDepth?: number | null;
  projected: Projection | null;
  handleProps: HandleProps;
  wrapperProps: WrapperProps;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onOpenCreateDialog: (parentId: string | null) => void;
  mutate: () => void;
  isTrashView?: boolean;
  // For file drop indicators
  fileDragState?: {
    overId: string | null;
    dropPosition: DropPosition;
  };
}

export function PageTreeItem({
  item,
  depth,
  isActive,
  isOver,
  dropPosition: internalDropPosition,
  projectedDepth,
  projected,
  handleProps,
  wrapperProps,
  isExpanded,
  onToggleExpand,
  onOpenCreateDialog,
  mutate,
  isTrashView = false,
  fileDragState,
}: PageTreeItemProps) {
  // Silence unused var - projected is passed but only needed for future use
  void projected;

  // Use projected depth for indicator positioning when available
  const indicatorDepth = projectedDepth ?? depth;

  const [isHovered, setIsHovered] = useState(false);
  const [isConfirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [isRenameOpen, setRenameOpen] = useState(false);
  const [isMoveOpen, setMoveOpen] = useState(false);
  const [isCopyOpen, setCopyOpen] = useState(false);
  const params = useParams();
  const { addFavorite, removeFavorite, isFavorite } = useFavorites();
  const createTab = useTabsStore((state) => state.createTab);
  const isTouchDevice = useTouchDevice();
  const hasChildren = item.children && item.children.length > 0;
  const driveId = params.driveId as string;

  // Multi-select state
  const {
    isMultiSelectMode,
    activeDriveId,
    enterMultiSelectMode,
    togglePageSelection,
    isSelected,
  } = useMultiSelectStore();

  const isInMultiSelectMode = isMultiSelectMode && activeDriveId === driveId;
  const isPageSelected = isSelected(item.id);

  // Memoize page info for selection to prevent unnecessary re-renders
  const pageInfo: SelectedPageInfo = useMemo(() => ({
    id: item.id,
    title: item.title,
    type: item.type,
    driveId: driveId,
    parentId: item.parentId ?? null,
  }), [item.id, item.title, item.type, item.parentId, driveId]);

  const handleEnterMultiSelect = useCallback(() => {
    enterMultiSelectMode(driveId);
    togglePageSelection(pageInfo);
  }, [enterMultiSelectMode, driveId, togglePageSelection, pageInfo]);

  const handleCheckboxClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    togglePageSelection(pageInfo);
  }, [togglePageSelection, pageInfo]);

  const linkHref = `/dashboard/${params.driveId}/${item.id}`;

  // Handle Cmd/Ctrl+click or middle-click to open in new tab
  const handleLinkClick = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    if (shouldOpenInNewTab(e)) {
      e.preventDefault();
      createTab({ path: linkHref, activate: false });
    }
    // Normal clicks are handled by useTabSync via URL change
  }, [linkHref, createTab]);

  // Handle middle-click on mousedown (for middle-click detection)
  const handleMouseDown = useCallback((e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (e.button === 1) {
      e.preventDefault();
      createTab({ path: linkHref, activate: false });
    }
  }, [linkHref, createTab]);

  // Open in new tab from context menu (opens in background like browsers)
  const handleOpenInNewTab = useCallback(() => {
    createTab({ path: linkHref, activate: false });
  }, [linkHref, createTab]);

  // Combine file drops AND internal dnd-kit drags for drop indicators
  const isFileDragOver = fileDragState?.overId === item.id;
  const isInternalDragOver = isOver && !isActive;
  const showDropIndicator = isFileDragOver || isInternalDragOver;

  // Determine drop position:
  // - For file drags: use fileDragState.dropPosition
  // - For internal drags: use dropPosition from SortableTree
  const dropPosition: DropPosition = isFileDragOver
    ? fileDragState?.dropPosition ?? null
    : internalDropPosition ?? null;

  const handleRename = async (newName: string) => {
    const toastId = toast.loading("Renaming page...");
    try {
      await patch(`/api/pages/${item.id}`, { title: newName });
      await mutate();
      toast.success("Page renamed.", { id: toastId });
    } catch {
      toast.error("Error renaming page.", { id: toastId });
    } finally {
      setRenameOpen(false);
    }
  };

  const handleDelete = async (trashChildren: boolean) => {
    const toastId = toast.loading("Moving page to trash...");
    try {
      await del(`/api/pages/${item.id}`, { trash_children: trashChildren });
      await mutate();
      toast.success("Page moved to trash.", { id: toastId });
    } catch {
      toast.error("Error moving page to trash.", { id: toastId });
    } finally {
      setConfirmTrashOpen(false);
    }
  };

  const handleRestore = async () => {
    const toastId = toast.loading("Restoring page...");
    try {
      await post(`/api/pages/${item.id}/restore`);
      await mutate();
      toast.success("Page restored.", { id: toastId });
    } catch {
      toast.error("Error restoring page.", { id: toastId });
    }
  };

  const handlePermanentDelete = async () => {
    const toastId = toast.loading("Permanently deleting page...");
    try {
      await del(`/api/trash/${item.id}`);
      await mutate();
      toast.success("Page permanently deleted.", { id: toastId });
    } catch {
      toast.error("Error permanently deleting page.", { id: toastId });
    }
  };

  const handleFavoriteToggle = async () => {
    const isCurrentlyFavorite = isFavorite(item.id);
    const action = isCurrentlyFavorite ? removeFavorite : addFavorite;
    const actionVerb = isCurrentlyFavorite ? "Removing from" : "Adding to";
    const toastId = toast.loading(`${actionVerb} favorites...`);
    try {
      await action(item.id);
      toast.success(`Page ${actionVerb.toLowerCase()} favorites.`, { id: toastId });
    } catch {
      toast.error(`Error updating favorites.`, { id: toastId });
    }
  };

  return (
    <>
      <div
        ref={wrapperProps.ref}
        style={wrapperProps.style}
        className={cn("relative", isActive && "z-50")}
        onMouseEnter={() => !isTouchDevice && setIsHovered(true)}
        onMouseLeave={() => !isTouchDevice && setIsHovered(false)}
      >
        {/* Drop indicator - BEFORE */}
        {showDropIndicator && dropPosition === "before" && (
          <div className="relative">
            <div
              className="absolute left-0 right-0 h-0.5 bg-primary -top-[1px] pointer-events-none z-10"
              style={{ left: `${indicatorDepth * 12 + 4}px` }}
            />
            <div className="h-0.5 w-full" />
          </div>
        )}

        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              {...handleProps.attributes}
              data-tree-node-id={item.id}
              className={cn(
                "group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0",
                showDropIndicator && dropPosition === "inside" &&
                  "bg-primary/10 dark:bg-primary/20 ring-2 ring-primary ring-inset",
                !isActive && !showDropIndicator &&
                  "hover:bg-gray-200 dark:hover:bg-gray-700",
                params.pageId === item.id && "bg-gray-200 dark:bg-gray-700",
                isInMultiSelectMode && isPageSelected && "bg-primary/10 dark:bg-primary/20 ring-1 ring-primary/50"
              )}
              style={{ paddingLeft: `${depth * 8 + 4}px` }}
            >
              {/* Multi-select Checkbox */}
              {isInMultiSelectMode && (
                <div
                  className="flex items-center mr-1"
                  onClick={handleCheckboxClick}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isPageSelected}
                    className="h-4 w-4"
                    aria-label={`Select ${item.title}`}
                  />
                </div>
              )}

              {/* Expand/Collapse Chevron */}
              {hasChildren && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleExpand(item.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? "Collapse" : "Expand"}
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors cursor-pointer"
                >
                  <ChevronRight
                    className={cn(
                      "h-4 w-4 text-gray-500 transition-transform duration-200",
                      isExpanded && "rotate-90"
                    )}
                  />
                </button>
              )}

              {/* Icon - Drag Handle */}
              <div
                ref={handleProps.ref}
                {...handleProps.listeners}
                className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 cursor-grab active:cursor-grabbing touch-manipulation"
              >
                <PageTypeIcon
                  type={item.type}
                  isTaskLinked={item.isTaskLinked}
                  className={cn(
                    "h-4 w-4 flex-shrink-0",
                    hasChildren ? "text-primary" : "text-gray-500"
                  )}
                />
              </div>

              {/* Change indicator dot */}
              {item.hasChanges && (
                <span
                  role="img"
                  className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0 ml-1"
                  aria-label="Has changes since last viewed"
                />
              )}

              {/* Title - Click to Navigate */}
              <Link
                href={linkHref}
                onClick={handleLinkClick}
                onMouseDown={handleMouseDown}
                onPointerDown={(e) => e.stopPropagation()}
                onTouchEnd={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 ml-1.5 truncate text-sm font-medium text-gray-900 dark:text-gray-100 hover:underline cursor-pointer touch-manipulation"
              >
                {item.title}
              </Link>

              {/* Action Button - Add child */}
              <div
                className={cn(
                  "flex items-center ml-2 transition-opacity duration-200",
                  isHovered ? "opacity-100" : "opacity-0"
                )}
              >
                <button
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenCreateDialog(item.id);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  aria-label="Add child page"
                >
                  <Plus className="h-3 w-3 text-gray-500" />
                </button>
              </div>

              {/* Visual hint for inside drop */}
              {showDropIndicator && dropPosition === "inside" && (
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute inset-x-4 inset-y-1 border-2 border-primary rounded-md opacity-50" />
                </div>
              )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-48">
            {isTrashView ? (
              <>
                <ContextMenuItem onSelect={handleRestore}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  <span>Restore</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={handlePermanentDelete}
                  className="text-red-500 focus:text-red-500"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Delete Permanently</span>
                </ContextMenuItem>
              </>
            ) : (
              <>
                <ContextMenuItem onSelect={handleOpenInNewTab}>
                  <ExternalLink className="mr-2 h-4 w-4" />
                  <span>Open in new tab</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => onOpenCreateDialog(item.id)}>
                  <FolderPlus className="mr-2 h-4 w-4" />
                  <span>Add child page</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setRenameOpen(true)}>
                  <Pencil className="mr-2 h-4 w-4" />
                  <span>Rename</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={handleFavoriteToggle}>
                  <Star
                    className={cn(
                      "mr-2 h-4 w-4",
                      isFavorite(item.id) && "text-yellow-500 fill-yellow-500"
                    )}
                  />
                  <span>{isFavorite(item.id) ? "Unfavorite" : "Favorite"}</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={handleEnterMultiSelect}>
                  <CheckSquare className="mr-2 h-4 w-4" />
                  <span>Select multiple</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setMoveOpen(true)}>
                  <FolderInput className="mr-2 h-4 w-4" />
                  <span>Move to...</span>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setCopyOpen(true)}>
                  <Copy className="mr-2 h-4 w-4" />
                  <span>Copy to...</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  onSelect={() => setConfirmTrashOpen(true)}
                  className="text-red-500 focus:text-red-500"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  <span>Trash</span>
                </ContextMenuItem>
              </>
            )}
          </ContextMenuContent>
        </ContextMenu>

        {/* Drop indicator - AFTER */}
        {showDropIndicator && dropPosition === "after" && (
          <div className="relative">
            <div className="h-0.5 w-full" />
            <div
              className="absolute left-0 right-0 h-0.5 bg-primary -bottom-[1px] pointer-events-none z-10"
              style={{ left: `${indicatorDepth * 12 + 4}px` }}
            />
          </div>
        )}
      </div>

      <DeletePageDialog
        isOpen={isConfirmTrashOpen}
        onClose={() => setConfirmTrashOpen(false)}
        onConfirm={handleDelete}
        hasChildren={hasChildren}
      />

      <RenameDialog
        isOpen={isRenameOpen}
        onClose={() => setRenameOpen(false)}
        onRename={handleRename}
        initialName={item.title}
        title="Rename Page"
        description="Enter a new name for your page."
      />

      <MovePageDialog
        isOpen={isMoveOpen}
        onClose={() => setMoveOpen(false)}
        pages={[pageInfo]}
        onSuccess={() => mutate()}
      />

      <CopyPageDialog
        isOpen={isCopyOpen}
        onClose={() => setCopyOpen(false)}
        pages={[pageInfo]}
        onSuccess={() => mutate()}
      />
    </>
  );
}
