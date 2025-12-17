"use client";

import { useState, CSSProperties, MouseEvent, useCallback } from "react";
import {
  Trash2,
  Pencil,
  Star,
  Undo2,
  FolderInput,
} from "lucide-react";
import { TreePage } from "@/hooks/usePageTree";
import { useFavorites } from "@/hooks/useFavorites";
import { toast } from "sonner";
import { DeletePageDialog } from "@/components/dialogs/DeletePageDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { patch, del, post } from "@/lib/auth/auth-fetch";
import { Projection } from "@/lib/tree/sortable-tree";
import { useSortable } from "@dnd-kit/sortable";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PageTreeItemContent, DropPosition } from "./PageTreeItemContent";
import { usePageSelection } from "@/hooks/useUI";
import { SelectionMode } from "@/stores/useUIStore";

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
  // For range selection
  flattenedIds?: string[];
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
  flattenedIds = [],
}: PageTreeItemProps) {
  // Silence unused var - projected is passed but only needed for future use
  void projected;

  // Use projected depth for indicator positioning when available
  const indicatorDepth = projectedDepth ?? depth;

  const [isHovered, setIsHovered] = useState(false);
  const [isConfirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [isRenameOpen, setRenameOpen] = useState(false);
  const { addFavorite, removeFavorite, isFavorite } = useFavorites();
  const {
    isSelected,
    selectPage,
    clearSelection,
    getSelectedIds,
    isMultiSelect,
  } = usePageSelection();

  const hasChildren = item.children && item.children.length > 0;
  const itemIsSelected = isSelected(item.id);
  const multiSelectActive = isMultiSelect();

  // Combine file drops AND internal dnd-kit drags for drop indicators
  const isFileDragOver = fileDragState?.overId === item.id;
  const isInternalDragOver = isOver && !isActive;
  const showDropIndicator = isFileDragOver || isInternalDragOver;

  // Determine drop position
  const dropPosition: DropPosition = isFileDragOver
    ? fileDragState?.dropPosition ?? null
    : internalDropPosition ?? null;

  // Action handlers
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

  const handleBatchDelete = async () => {
    const selectedIds = getSelectedIds();
    if (selectedIds.length === 0) return;

    const toastId = toast.loading(`Moving ${selectedIds.length} pages to trash...`);
    try {
      await post("/api/pages/batch-trash", { pageIds: selectedIds });
      clearSelection();
      await mutate();
      toast.success(`${selectedIds.length} pages moved to trash.`, { id: toastId });
    } catch {
      toast.error("Error moving pages to trash.", { id: toastId });
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

  // Selection click handler
  const handleSelectionClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();

      // Determine selection mode based on modifier keys
      let mode: SelectionMode = "toggle";
      if (e.shiftKey) {
        mode = "range";
      } else if (e.ctrlKey || e.metaKey) {
        mode = "toggle";
      }

      selectPage(item.id, mode, flattenedIds);
    },
    [item.id, selectPage, flattenedIds]
  );

  // Row click handler
  const handleRowClick = useCallback(
    (e: MouseEvent) => {
      // If clicking on selection checkbox area, handled separately
      if ((e.target as HTMLElement).closest("[data-selection-checkbox]")) {
        return;
      }

      // Handle selection with modifier keys
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        selectPage(item.id, "toggle", flattenedIds);
      } else if (e.shiftKey) {
        e.preventDefault();
        selectPage(item.id, "range", flattenedIds);
      }
      // Normal click navigates (handled by Link)
    },
    [item.id, selectPage, flattenedIds]
  );

  // Context menu handler
  const handleContextMenu = useCallback(
    () => {
      // If this item is not selected, select it first (single selection)
      if (!itemIsSelected) {
        clearSelection();
        selectPage(item.id, "single");
      }
      // Context menu will show batch options if multiple selected
    },
    [item.id, itemIsSelected, clearSelection, selectPage]
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div ref={wrapperProps.ref} style={wrapperProps.style}>
            <PageTreeItemContent
              ref={handleProps.ref}
              item={item}
              depth={depth}
              isSelected={itemIsSelected}
              isActive={isActive}
              showDropIndicator={showDropIndicator}
              dropPosition={dropPosition}
              indicatorDepth={indicatorDepth}
              isExpanded={isExpanded}
              hasChildren={hasChildren}
              isFavorite={isFavorite(item.id)}
              isHovered={isHovered}
              isTrashView={isTrashView}
              onToggleExpand={onToggleExpand}
              onOpenCreateDialog={onOpenCreateDialog}
              onRename={() => setRenameOpen(true)}
              onTrash={() => setConfirmTrashOpen(true)}
              onRestore={handleRestore}
              onPermanentDelete={handlePermanentDelete}
              onFavoriteToggle={handleFavoriteToggle}
              onMouseEnter={() => setIsHovered(true)}
              onMouseLeave={() => setIsHovered(false)}
              onClick={handleRowClick}
              onContextMenu={handleContextMenu}
              onSelectionClick={handleSelectionClick}
              dragHandleProps={{
                listeners: handleProps.listeners,
                attributes: handleProps.attributes,
              }}
            />
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent className="w-52">
          {isTrashView ? (
            <>
              <ContextMenuItem onSelect={handleRestore}>
                <Undo2 className="mr-2 h-4 w-4" />
                <span>Restore</span>
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={handlePermanentDelete}
                variant="destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Delete Permanently</span>
              </ContextMenuItem>
            </>
          ) : multiSelectActive && itemIsSelected ? (
            // Multi-select context menu
            <>
              <ContextMenuItem disabled>
                <FolderInput className="mr-2 h-4 w-4" />
                <span>Move {getSelectedIds().length} pages...</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={handleBatchDelete}
                variant="destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Trash {getSelectedIds().length} pages</span>
              </ContextMenuItem>
            </>
          ) : (
            // Single item context menu
            <>
              <ContextMenuItem onSelect={() => setRenameOpen(true)}>
                <Pencil className="mr-2 h-4 w-4" />
                <span>Rename</span>
              </ContextMenuItem>
              <ContextMenuItem onSelect={handleFavoriteToggle}>
                <Star
                  className={
                    isFavorite(item.id)
                      ? "mr-2 h-4 w-4 text-yellow-500 fill-yellow-500"
                      : "mr-2 h-4 w-4"
                  }
                />
                <span>{isFavorite(item.id) ? "Unfavorite" : "Favorite"}</span>
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() => setConfirmTrashOpen(true)}
                variant="destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                <span>Trash</span>
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

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
    </>
  );
}

// Re-export DropPosition for backwards compatibility
export type { DropPosition };
