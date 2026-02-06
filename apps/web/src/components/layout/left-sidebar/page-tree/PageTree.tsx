"use client";

import { useState, useMemo, useCallback } from "react";
import { FileIcon } from "lucide-react";
import { patch } from "@/lib/auth/auth-fetch";
import { TreePage } from "@/hooks/usePageTree";
import { usePageTreeSocket } from "@/hooks/usePageTreeSocket";
import { findNodeAndParent } from "@/lib/tree/tree-utils";
import { Skeleton } from "@/components/ui/skeleton";
import { PullToRefresh } from "@/components/ui/pull-to-refresh";
import { CustomScrollArea } from "@/components/ui/custom-scroll-area";
import CreatePageDialog from "../CreatePageDialog";
import { useTreeState } from "@/hooks/useUI";
import { useFileDrop } from "@/hooks/useFileDrop";
import { cn } from "@/lib/utils";
import { SortableTree } from "@/components/ui/sortable-tree";
import { Projection, TreeItem } from "@/lib/tree/sortable-tree";
import { PageTreeItem, DropPosition } from "./PageTreeItem";
import { MultiSelectToolbar } from "./MultiSelectToolbar";
import { KeyedMutator } from "swr";

interface PageTreeProps {
  driveId: string;
  initialTree?: TreePage[];
  mutate?: KeyedMutator<TreePage[]>;
  isTrashView?: boolean;
  searchQuery?: string;
}

// Extend TreePage to satisfy TreeItem interface
type SortableTreePage = TreePage & TreeItem;

export default function PageTree({
  driveId,
  initialTree,
  mutate: externalMutate,
  isTrashView = false,
  searchQuery = "",
}: PageTreeProps) {
  const { tree: fetchedTree, isLoading, mutate: internalMutate } = usePageTreeSocket(driveId, isTrashView);
  const tree = initialTree ?? fetchedTree;
  const mutate = externalMutate ?? internalMutate;
  const { expanded: expandedNodes, toggleExpanded } = useTreeState();

  const [createPageInfo, setCreatePageInfo] = useState<{
    isOpen: boolean;
    parentId: string | null;
  }>({ isOpen: false, parentId: null });

  // File drag state (native HTML5 drag, separate from dnd-kit)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [fileDragState, setFileDragState] = useState<{
    overId: string | null;
    dropPosition: DropPosition;
    dragStartPos: { x: number; y: number } | null;
  }>({
    overId: null,
    dropPosition: null,
    dragStartPos: null,
  });

  // File upload handling
  const { isUploading, uploadProgress, handleFileDrop } = useFileDrop({
    driveId,
    parentId: null,
    onUploadComplete: () => mutate(),
  });

  // Filter tree by search query
  const filterTree = useCallback((nodes: TreePage[], query: string): TreePage[] => {
    if (!query) return nodes;
    const lowerQuery = query.toLowerCase();

    function filter(items: TreePage[]): TreePage[] {
      return items.reduce<TreePage[]>((acc, item) => {
        const children = item.children ? filter(item.children) : [];
        if (item.title.toLowerCase().includes(lowerQuery) || children.length > 0) {
          acc.push({ ...item, children });
        }
        return acc;
      }, []);
    }

    return filter(nodes);
  }, []);

  const displayedTree = useMemo(() => {
    if (!searchQuery.trim()) return tree;
    return filterTree(tree, searchQuery);
  }, [tree, searchQuery, filterTree]);

  // Collapsed IDs for SortableTree (inverted from expanded)
  const collapsedIds = useMemo(() => {
    const allIds = new Set<string>();
    const collectIds = (items: TreePage[]) => {
      for (const item of items) {
        if (!expandedNodes.has(item.id)) {
          allIds.add(item.id);
        }
        if (item.children?.length) {
          collectIds(item.children);
        }
      }
    };
    collectIds(displayedTree);
    return allIds;
  }, [displayedTree, expandedNodes]);

  // Handle move from SortableTree
  const handleMove = useCallback(
    async (activeId: string, _overId: string, projection: Projection) => {
      const activeInfo = findNodeAndParent(tree, activeId);
      if (!activeInfo) return;

      const newParentId = projection.parentId;

      // Get siblings at the new parent location
      const newParent = newParentId ? findNodeAndParent(tree, newParentId)?.node : null;
      const siblings = newParent ? newParent.children : tree;

      // Filter out the active item from siblings (it's being moved)
      const siblingsWithoutActive = siblings.filter(s => s.id !== activeId);

      // Use projection.insertionIndex for correct position calculation
      const insertAt = projection.insertionIndex;

      let newPosition: number;
      if (siblingsWithoutActive.length === 0) {
        // No siblings - first child
        newPosition = 1;
      } else if (insertAt === 0) {
        // Insert at beginning
        const firstSibling = siblingsWithoutActive[0];
        newPosition = (firstSibling?.position ?? 1) / 2;
      } else if (insertAt >= siblingsWithoutActive.length) {
        // Insert at end
        const lastSibling = siblingsWithoutActive[siblingsWithoutActive.length - 1];
        newPosition = (lastSibling?.position ?? 0) + 1;
      } else {
        // Insert between two items
        const prev = siblingsWithoutActive[insertAt - 1];
        const next = siblingsWithoutActive[insertAt];
        newPosition = ((prev?.position ?? 0) + (next?.position ?? (prev?.position ?? 0) + 2)) / 2;
      }

      // Auto-expand parent if dropping inside
      if (newParentId && !expandedNodes.has(newParentId)) {
        toggleExpanded(newParentId);
      }

      try {
        await patch("/api/pages/reorder", {
          pageId: activeId,
          newParentId: newParentId,
          newPosition: newPosition,
        });
        await mutate();
      } catch (error) {
        console.error("Failed to reorder page:", error);
      }
    },
    [tree, mutate, expandedNodes, toggleExpanded]
  );

  const handleToggleExpand = useCallback(
    (id: string) => {
      toggleExpanded(id);
    },
    [toggleExpanded]
  );

  const handleOpenCreateDialog = useCallback((parentId: string | null) => {
    setCreatePageInfo({ isOpen: true, parentId });
  }, []);

  const handlePageCreated = useCallback(() => {
    mutate();
  }, [mutate]);

  // File drop handlers (native HTML5 drag events)
  const handleFileDragEnter = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
      setIsDraggingFiles(true);
      setFileDragState((prev) => {
        if (prev.dragStartPos) {
          return prev;
        }

        return {
          overId: null,
          dropPosition: null,
          dragStartPos: { x: e.clientX, y: e.clientY },
        };
      });
    }
  }, []);

  const handleFileDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) {
      setIsDraggingFiles(false);
      setFileDragState((prev) => {
        if (prev.overId === null && prev.dropPosition === null && prev.dragStartPos === null) {
          return prev;
        }
        return { overId: null, dropPosition: null, dragStartPos: null };
      });
    }
  }, []);

  const handleFileDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!isDraggingFiles) {
        return;
      }

      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";

      const target = e.target as HTMLElement;
      const treeNode = target.closest("[data-tree-node-id]");

      setFileDragState((prev) => {
        if (!prev.dragStartPos) {
          return prev;
        }

        let nextOverId: string | null = null;
        let nextDropPosition: DropPosition = null;

        if (treeNode) {
          const nodeId = treeNode.getAttribute("data-tree-node-id");
          const rect = treeNode.getBoundingClientRect();
          const relativeY = e.clientY - rect.top;
          const heightPercent = relativeY / rect.height;
          const deltaX = e.clientX - prev.dragStartPos.x;

          if (deltaX > 30) {
            nextDropPosition = "inside";
          } else if (heightPercent < 0.4) {
            nextDropPosition = "before";
          } else if (heightPercent > 0.6) {
            nextDropPosition = "after";
          } else {
            nextDropPosition = prev.dropPosition || "after";
          }

          nextOverId = nodeId;
        }

        if (prev.overId === nextOverId && prev.dropPosition === nextDropPosition) {
          return prev;
        }

        return {
          ...prev,
          overId: nextOverId,
          dropPosition: nextDropPosition,
        };
      });
    },
    [isDraggingFiles]
  );

  const handleFileDropEvent = useCallback(
    async (e: React.DragEvent) => {
      if (isDraggingFiles) {
        e.preventDefault();
        e.stopPropagation();

        const files = e.dataTransfer.files;
        if (files.length > 0) {
          if (fileDragState.overId) {
            const targetInfo = findNodeAndParent(tree, fileDragState.overId);
            if (targetInfo) {
              let parentId: string | null = null;
              let position: "before" | "after" | null = null;
              let afterNodeId: string | null = null;

              if (fileDragState.dropPosition === "inside") {
                parentId = fileDragState.overId;
              } else if (fileDragState.dropPosition) {
                parentId = targetInfo.parent?.id || null;
                position = fileDragState.dropPosition;
                afterNodeId = fileDragState.overId;
              }

              await handleFileDrop(e, parentId, position, afterNodeId);
            }
          } else {
            await handleFileDrop(e, null, null, null);
          }
        }

        setIsDraggingFiles(false);
        setFileDragState((prev) => {
          if (prev.overId === null && prev.dropPosition === null && prev.dragStartPos === null) {
            return prev;
          }
          return { overId: null, dropPosition: null, dragStartPos: null };
        });
      }
    },
    [isDraggingFiles, fileDragState, tree, handleFileDrop]
  );

  const handleRefresh = useCallback(async () => {
    await mutate();
  }, [mutate]);

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full ml-6" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  return (
    <PullToRefresh direction="top" onRefresh={handleRefresh}>
      <CustomScrollArea className="h-full">
        <MultiSelectToolbar driveId={driveId} onMutate={mutate} />
        <div
          className={cn("relative", isDraggingFiles && "bg-primary/5")}
          onDragEnter={handleFileDragEnter}
          onDragLeave={handleFileDragLeave}
          onDragOver={handleFileDragOver}
          onDrop={handleFileDropEvent}
        >
          <nav className="px-1 py-2 min-h-[200px]">
            <SortableTree
              items={displayedTree as SortableTreePage[]}
              collapsedIds={collapsedIds}
              indentationWidth={12}
              onMove={handleMove}
              renderItem={({ item, depth, isActive, isOver, dropPosition, projectedDepth, projected, handleProps, wrapperProps }) => (
                <PageTreeItem
                  item={item as TreePage}
                  depth={depth}
                  isActive={isActive}
                  isOver={isOver}
                  dropPosition={dropPosition}
                  projectedDepth={projectedDepth}
                  projected={projected}
                  handleProps={handleProps}
                  wrapperProps={wrapperProps}
                  isExpanded={expandedNodes.has(item.id)}
                  onToggleExpand={handleToggleExpand}
                  onOpenCreateDialog={handleOpenCreateDialog}
                  mutate={mutate}
                  isTrashView={isTrashView}
                  fileDragState={fileDragState}
                />
              )}
            />

            {/* Empty state drop zone */}
            {isDraggingFiles && !fileDragState.overId && displayedTree.length === 0 && (
              <div className="flex items-center justify-center py-8 px-4 border-2 border-dashed border-primary/20 rounded-lg bg-primary/5">
                <div className="text-center">
                  <FileIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Drop files here to upload</p>
                </div>
              </div>
            )}

            {/* Drop zone at bottom */}
            {isDraggingFiles && !fileDragState.overId && displayedTree.length > 0 && (
              <div className="mt-2 py-2 px-4 border-2 border-dashed border-primary/20 rounded-lg bg-primary/5">
                <p className="text-sm text-muted-foreground text-center">Drop here to add to root</p>
              </div>
            )}
          </nav>

          {/* File drag overlay */}
          {isDraggingFiles && fileDragState.dragStartPos && (
            <div
              className="fixed pointer-events-none z-[9999]"
              style={{
                left: fileDragState.dragStartPos.x + 10,
                top: fileDragState.dragStartPos.y - 10,
              }}
            >
              <div className="flex items-center px-3 py-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 opacity-90">
                <FileIcon className="h-4 w-4 text-gray-500 mr-2" />
                <span className="text-sm font-medium">Upload files</span>
              </div>
            </div>
          )}

          <CreatePageDialog
            isOpen={createPageInfo.isOpen}
            setIsOpen={(isOpen) => setCreatePageInfo({ ...createPageInfo, isOpen })}
            parentId={createPageInfo.parentId}
            onPageCreated={handlePageCreated}
            driveId={driveId}
          />

          {/* Upload progress indicator */}
          {isUploading && (
            <div className="absolute bottom-4 right-4 bg-background border rounded-lg p-3 shadow-lg z-50">
              <p className="text-sm font-medium mb-2">Uploading files...</p>
              <div className="w-48 h-2 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      </CustomScrollArea>
    </PullToRefresh>
  );
}
