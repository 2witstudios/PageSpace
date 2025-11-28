"use client";

import { useState } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronRight,
  Plus,
  MoreHorizontal,
  Trash2,
  Pencil,
  Star,
  Undo2,
} from "lucide-react";
import { useParams } from "next/navigation";
import { TreePage } from "@/hooks/usePageTree";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { DragState } from "./PageTree";
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
import { patch, del, post } from '@/lib/auth/auth-fetch';

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

  // Calculate animations for external file drags
  const isDisplaced = dragState.isExternalFile && dragState.displacedNodes?.has(node.id);
  
  // Use margin for external file drags, transform for internal drags
  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition || (isDisplaced ? 'margin 150ms cubic-bezier(0.25, 1, 0.5, 1)' : undefined),
    opacity: isDragging ? 0 : 1,
    marginTop: isDisplaced ? '10px' : undefined, // Match native displacement
  };



  const linkHref = `/dashboard/${params.driveId}/${node.id}`;

  const handleRename = async (newName: string) => {
    const toastId = toast.loading("Renaming page...");
    try {
      await patch(`/api/pages/${node.id}`, { title: newName });
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
      await del(`/api/pages/${node.id}`, { trash_children: trashChildren });
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
      await post(`/api/pages/${node.id}/restore`);
      await mutate();
      toast.success("Page restored.", { id: toastId });
    } catch {
      toast.error("Error restoring page.", { id: toastId });
    }
  };

  const handlePermanentDelete = async () => {
    const toastId = toast.loading("Permanently deleting page...");
    try {
      await del(`/api/trash/${node.id}`);
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
  const isFileDrag = dragState.isExternalFile;
  const showDropIndicator = isOverThisNode && (!isActiveNode || isFileDrag);

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
          <div className="relative">
            <div
              className="absolute left-0 right-0 h-0.5 bg-primary -top-[1px] pointer-events-none z-10"
              style={{ left: `${depth * 24 + 8}px` }}
            />
            {/* Subtle gap for visual feedback */}
            <div className="h-0.5 w-full" />
          </div>
        )}
        
        <div
          {...attributes}
          {...listeners}
          data-tree-node-id={node.id}
          className={`
            group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200 cursor-grab active:cursor-grabbing
            ${
              showDropIndicator && dragState.dropPosition === "inside"
                ? "bg-primary/10 dark:bg-primary/20 ring-2 ring-primary ring-inset"
                : ""
            }
            ${
              !isDragging && !showDropIndicator
                ? "hover:bg-gray-100 dark:hover:bg-gray-800"
                : ""
            }
            ${
              params.pageId === node.id ? "bg-gray-200 dark:bg-gray-700" : ""
            }
          `}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
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
            <PageTypeIcon
              type={node.type}
              className={`
              h-4 w-4 mr-1.5 flex-shrink-0
              ${hasChildren ? "text-primary" : "text-gray-500"}
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

          {/* Visual hint for drop zones */}
          {showDropIndicator && dragState.dropPosition === "inside" ? (
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute inset-x-4 inset-y-1 border-2 border-primary rounded-md opacity-50" />
            </div>
          ) : null}
        </div>

        {/* Drop indicator - AFTER */}
        {showDropIndicator && dragState.dropPosition === "after" && (
          <div className="relative">
            {/* Subtle gap for visual feedback */}
            <div className="h-0.5 w-full" />
            <div
              className="absolute left-0 right-0 h-0.5 bg-primary -bottom-[1px] pointer-events-none z-10"
              style={{ left: `${depth * 24 + 8}px` }}
            />
          </div>
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