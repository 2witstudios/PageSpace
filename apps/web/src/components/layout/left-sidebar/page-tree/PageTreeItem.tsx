"use client";

import { useState, CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ChevronRight,
  Plus,
  Trash2,
  Pencil,
  Star,
  Undo2,
} from "lucide-react";
import { TreePage } from "@/hooks/usePageTree";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useFavorites } from "@/hooks/useFavorites";
import { toast } from "sonner";
import { DeletePageDialog } from "@/components/dialogs/DeletePageDialog";
import { RenameDialog } from "@/components/dialogs/RenameDialog";
import { patch, del, post } from "@/lib/auth/auth-fetch";
import { Projection } from "@/lib/tree/sortable-tree";
import { cn } from "@/lib/utils";
import { useSortable } from "@dnd-kit/sortable";

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
  const params = useParams();
  const { addFavorite, removeFavorite, isFavorite } = useFavorites();
  const hasChildren = item.children && item.children.length > 0;

  const linkHref = `/dashboard/${params.driveId}/${item.id}`;

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
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
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
              ref={handleProps.ref}
              {...handleProps.attributes}
              {...handleProps.listeners}
              data-tree-node-id={item.id}
              className={cn(
                "group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 cursor-grab active:cursor-grabbing outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0",
                showDropIndicator && dropPosition === "inside" &&
                  "bg-primary/10 dark:bg-primary/20 ring-2 ring-primary ring-inset",
                !isActive && !showDropIndicator &&
                  "hover:bg-gray-200 dark:hover:bg-gray-700",
                params.pageId === item.id && "bg-gray-200 dark:bg-gray-700"
              )}
              style={{ paddingLeft: `${depth * 8 + 4}px` }}
            >
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

              {/* Icon */}
              <div className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
                <PageTypeIcon
                  type={item.type}
                  isTaskLinked={item.isTaskLinked}
                  className={cn(
                    "h-4 w-4 flex-shrink-0",
                    hasChildren ? "text-primary" : "text-gray-500"
                  )}
                />
              </div>

              {/* Title - Click to Navigate */}
              <Link
                href={linkHref}
                onPointerDown={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 ml-1.5 truncate text-sm font-medium text-gray-900 dark:text-gray-100 hover:underline cursor-pointer"
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
    </>
  );
}
