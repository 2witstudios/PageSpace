"use client";

import { useState, CSSProperties } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ChevronRight,
  Plus,
  MoreHorizontal,
  Trash2,
  Pencil,
  Star,
  Undo2,
} from "lucide-react";
import { TreePage } from "@/hooks/usePageTree";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  // - For internal drags: use projected.parentId to detect "inside" vs "after"
  const dropPosition: DropPosition = isFileDragOver
    ? fileDragState?.dropPosition ?? null
    : isInternalDragOver && projected
      ? (projected.parentId === item.id ? "inside" : "after")
      : null;

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
              style={{ left: `${depth * 24 + 8}px` }}
            />
            <div className="h-0.5 w-full" />
          </div>
        )}

        <div
          ref={handleProps.ref}
          {...handleProps.attributes}
          {...handleProps.listeners}
          data-tree-node-id={item.id}
          className={cn(
            "group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 cursor-grab active:cursor-grabbing",
            showDropIndicator && dropPosition === "inside" &&
              "bg-primary/10 dark:bg-primary/20 ring-2 ring-primary ring-inset",
            !isActive && !showDropIndicator &&
              "hover:bg-gray-100 dark:hover:bg-gray-800",
            params.pageId === item.id && "bg-gray-200 dark:bg-gray-700"
          )}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          {/* Expand/Collapse Chevron */}
          {hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(item.id);
              }}
              aria-expanded={isExpanded}
              aria-label={isExpanded ? "Collapse" : "Expand"}
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 text-gray-500 transition-transform duration-200",
                  isExpanded && "rotate-90"
                )}
              />
            </button>
          )}

          {/* Icon and Title */}
          <Link
            href={linkHref}
            passHref
            className="flex items-center flex-1 min-w-0 ml-1 cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          >
            <PageTypeIcon
              type={item.type}
              isTaskLinked={item.isTaskLinked}
              className={cn(
                "h-4 w-4 mr-1.5 flex-shrink-0",
                hasChildren ? "text-primary" : "text-gray-500"
              )}
            />
            <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {item.title}
            </span>
          </Link>

          {/* Action Buttons */}
          <div
            className={cn(
              "flex items-center gap-1 ml-2 transition-opacity duration-200",
              isHovered ? "opacity-100" : "opacity-0"
            )}
          >
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.stopPropagation();
                onOpenCreateDialog(item.id);
              }}
              aria-label="Add child page"
            >
              <Plus className="h-3 w-3 text-gray-500" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="h-3 w-3 text-gray-500" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                onClick={(e) => e.stopPropagation()}
                className="w-48"
              >
                {isTrashView ? (
                  <>
                    <DropdownMenuItem onSelect={handleRestore}>
                      <Undo2 className="mr-2 h-4 w-4" />
                      <span>Restore</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={handlePermanentDelete}
                      className="text-red-500 focus:text-red-500"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      <span>Delete Permanently</span>
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      <span>Rename</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleFavoriteToggle}>
                      <Star
                        className={cn(
                          "mr-2 h-4 w-4",
                          isFavorite(item.id) && "text-yellow-500 fill-yellow-500"
                        )}
                      />
                      <span>{isFavorite(item.id) ? "Unfavorite" : "Favorite"}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => setConfirmTrashOpen(true)}
                      className="text-red-500 focus:text-red-500"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      <span>Trash</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Visual hint for inside drop */}
          {showDropIndicator && dropPosition === "inside" && (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-x-4 inset-y-1 border-2 border-primary rounded-md opacity-50" />
            </div>
          )}
        </div>

        {/* Drop indicator - AFTER */}
        {showDropIndicator && dropPosition === "after" && (
          <div className="relative">
            <div className="h-0.5 w-full" />
            <div
              className="absolute left-0 right-0 h-0.5 bg-primary -bottom-[1px] pointer-events-none z-10"
              style={{ left: `${depth * 24 + 8}px` }}
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
