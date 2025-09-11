"use client";

import { useState } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  FileText,
  Folder,
  Plus,
  MoreHorizontal,
  MessageSquare,
  Sparkles,
  Trash2,
  Pencil,
  Star,
  Undo2,
  FileIcon,
} from "lucide-react";
import { useParams } from "next/navigation";
import { TreePage } from "@/hooks/usePageTree";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { DragState, FileDropTarget } from "./PageTree";
import { PageType } from "@pagespace/lib";
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

interface TreeNodeProps {
  node: TreePage;
  depth: number;
  onToggleExpand: (id: string) => void;
  isExpanded: boolean;
  dragState: DragState;
  activeId: string | null;
  onOpenCreateDialog: (parentId: string | null) => void;
  mutate: () => void;
  isTrashView?: boolean;
  expandedNodes: Set<string>;
  isDraggingFiles?: boolean;
  fileDropTarget?: FileDropTarget;
  setFileDropTarget?: (target: FileDropTarget) => void;
}

export default function TreeNode({
  node,
  depth,
  onToggleExpand,
  isExpanded,
  dragState,
  activeId,
  onOpenCreateDialog,
  mutate,
  isTrashView = false,
  expandedNodes,
  isDraggingFiles = false,
  fileDropTarget,
  setFileDropTarget,
}: TreeNodeProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isConfirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [isRenameOpen, setRenameOpen] = useState(false);
  const params = useParams();
  const { addFavorite, removeFavorite, isFavorite } = useFavorites();
  const hasChildren = node.children && node.children.length > 0;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: node.id,
    data: { node, depth },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  const getIcon = (type: PageType) => {
    switch (type) {
      case PageType.FOLDER:
        return Folder;
      case PageType.DOCUMENT:
        return FileText;
      case PageType.CHANNEL:
        return MessageSquare;
      case PageType.AI_CHAT:
        return Sparkles;
      case PageType.FILE:
        return FileIcon;
      default:
        return FileText;
    }
  };

  const Icon = getIcon(node.type);


  const linkHref = `/dashboard/${params.driveId}/${node.id}`;

  const handleRename = async (newName: string) => {
    const toastId = toast.loading("Renaming page...");
    try {
      const response = await fetch(`/api/pages/${node.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newName }),
      });
      if (!response.ok) throw new Error("Failed to rename page.");
    await response.json();
    await mutate();
      // The title in the main content area will update automatically
      // because it also reads from the SWR cache via usePageTree.
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
      const response = await fetch(`/api/pages/${node.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trash_children: trashChildren }),
      });
      if (!response.ok) throw new Error("Failed to move page to trash.");
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
      const response = await fetch(`/api/pages/${node.id}/restore`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Failed to restore page.");
      await mutate();
      toast.success("Page restored.", { id: toastId });
    } catch {
      toast.error("Error restoring page.", { id: toastId });
    }
  };

  const handlePermanentDelete = async () => {
    const toastId = toast.loading("Permanently deleting page...");
    try {
      const response = await fetch(`/api/trash/${node.id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to permanently delete page.");
      await mutate();
      toast.success("Page permanently deleted.", { id: toastId });
    } catch {
      toast.error("Error permanently deleting page.", { id: toastId });
    }
  };

  const handleFavoriteToggle = async () => {
    const isCurrentlyFavorite = isFavorite(node.id);
    const action = isCurrentlyFavorite ? removeFavorite : addFavorite;
    const actionVerb = isCurrentlyFavorite ? "Removing from" : "Adding to";
    const toastId = toast.loading(`${actionVerb} favorites...`);
    try {
      await action(node.id);
      toast.success(`Page ${actionVerb.toLowerCase()} favorites.`, { id: toastId });
    } catch {
      toast.error(`Error updating favorites.`, { id: toastId });
    }
  };

  const isOverThisNode = dragState.overId === node.id;
  const isActiveNode = activeId === node.id;
  const showDropIndicator = isOverThisNode && !isActiveNode && !isDraggingFiles;
  // Any page can accept files (they can all act as containers), except in trash
  const canAcceptFiles = !isTrashView;
  
  // Show file drop indicator when dragging files and hovering over this specific page
  const isFileDropTarget = isDraggingFiles && fileDropTarget?.nodeId === node.id && fileDropTarget?.dropPosition === 'inside';
  const showFileDropIndicator = isFileDropTarget && canAcceptFiles;

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={`relative ${isDragging ? "z-50" : ""}`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Drop indicator - BEFORE */}
        {showDropIndicator && dragState.dropPosition === "before" && (
          <div
            className="absolute left-0 right-0 h-0.5 bg-blue-500 -top-[1px] pointer-events-none"
            style={{ left: `${depth * 24 + 8}px` }}
          />
        )}

        <div
          {...attributes}
          {...listeners}
          className={`
            group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 cursor-grab active:cursor-grabbing
            ${
              (showDropIndicator && dragState.dropPosition === "inside") || showFileDropIndicator
                ? "bg-blue-100 dark:bg-blue-900/30 ring-2 ring-blue-500 ring-inset"
                : ""
            }
            ${
              !isDragging && !showDropIndicator && !isDraggingFiles
                ? "hover:bg-gray-100 dark:hover:bg-gray-800"
                : ""
            }
            ${
              params.pageId === node.id ? "bg-gray-200 dark:bg-gray-700" : ""
            }
          `}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          onDragEnter={(e) => {
            if (isDraggingFiles && canAcceptFiles && setFileDropTarget) {
              e.preventDefault();
              e.stopPropagation();
              setFileDropTarget({ nodeId: node.id, dropPosition: 'inside' });
            }
          }}
          onDragLeave={(e) => {
            if (isDraggingFiles && canAcceptFiles && setFileDropTarget) {
              // Only clear if leaving to a non-child element
              const rect = e.currentTarget.getBoundingClientRect();
              const x = e.clientX;
              const y = e.clientY;
              if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
                if (fileDropTarget?.nodeId === node.id) {
                  setFileDropTarget({ nodeId: null, dropPosition: null });
                }
              }
            }
          }}
          onDragOver={(e) => {
            if (isDraggingFiles && canAcceptFiles) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
        >
          {/* Expand/Collapse Chevron */}
          {hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand(node.id);
              }}
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <ChevronRight
                className={`
                  h-4 w-4 text-gray-500 transition-transform duration-200
                  ${isExpanded ? "rotate-90" : ""}
                `}
              />
            </button>
          )}

          {/* Icon and Title */}
          <Link href={linkHref} passHref className="flex items-center flex-1 min-w-0 ml-1 cursor-pointer" onClick={(e) => e.stopPropagation()}>
            <Icon
              className={`
              h-4 w-4 mr-1.5 flex-shrink-0
              ${hasChildren ? "text-blue-500" : "text-gray-500"}
            `}
            />
            <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {node.title}
            </span>
          </Link>

          {/* Action Buttons */}
          <div
            className={`
            flex items-center gap-1 ml-2
            ${isHovered ? "opacity-100" : "opacity-0"}
            transition-opacity duration-200
          `}
          >
            <button
              className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
              onClick={(e) => {
                e.stopPropagation();
                onOpenCreateDialog(node.id);
              }}
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
                        className={`mr-2 h-4 w-4 ${
                          isFavorite(node.id) ? "text-yellow-500 fill-yellow-500" : ""
                        }`}
                      />
                      <span>{isFavorite(node.id) ? "Unfavorite" : "Favorite"}</span>
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

          {/* Visual hint for drop zones - reuse for both internal drag and file drops */}
          {(showDropIndicator && dragState.dropPosition === "inside") || showFileDropIndicator ? (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-x-4 inset-y-1 border-2 border-blue-500 rounded-md opacity-50" />
            </div>
          ) : null}
        </div>

        {/* Drop indicator - AFTER */}
        {showDropIndicator && dragState.dropPosition === "after" && (
          <div
            className="absolute left-0 right-0 h-0.5 bg-blue-500 -bottom-[1px] pointer-events-none"
            style={{ left: `${depth * 24 + 8}px` }}
          />
        )}
      </div>

      {/* Children */}
      {hasChildren && isExpanded && (
        <div className="relative">
          <SortableContext
            items={node.children.map((child) => child.id)}
            strategy={verticalListSortingStrategy}
          >
            {node.children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                onToggleExpand={onToggleExpand}
                isExpanded={expandedNodes.has(child.id)}
                dragState={dragState}
                activeId={activeId}
                onOpenCreateDialog={onOpenCreateDialog}
                mutate={mutate}
                isTrashView={isTrashView}
                expandedNodes={expandedNodes}
                isDraggingFiles={isDraggingFiles}
                fileDropTarget={fileDropTarget}
                setFileDropTarget={setFileDropTarget}
              />
            ))}
          </SortableContext>
        </div>
      )}

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
        initialName={node.title}
        title="Rename Page"
        description="Enter a new name for your page."
      />
    </>
  );
}