"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent, 
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  closestCenter,
  MeasuringStrategy
} from "@dnd-kit/core";
import { 
  SortableContext, 
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { TreePage } from "../../../../hooks/usePageTree";
import { usePageTreeSocket } from "../../../../hooks/usePageTreeSocket";
import { findNodeAndParent, removeNode, addNode } from "@/lib/tree/tree-utils";
import TreeNode from "./TreeNode";
import DragOverlayItem from "./DragOverlayItem";
import { Skeleton } from "@/components/ui/skeleton";
import CreatePageDialog from "../CreatePageDialog";
import { useTreeState } from "@/hooks/useUI";
import { useFileDrop } from "@/hooks/useFileDrop";
import { cn } from "@/lib/utils";

export type DropPosition = 'before' | 'after' | 'inside' | null;

export interface DragState {
  overId: string | null;
  dropPosition: DropPosition;
  isExternalFile?: boolean;
}

export interface FileDropTarget {
  nodeId: string | null;
  dropPosition: DropPosition;
}

import { KeyedMutator } from "swr";

interface PageTreeProps {
  driveId: string;
  initialTree?: TreePage[];
  mutate?: KeyedMutator<TreePage[]>;
  isTrashView?: boolean;
  searchQuery?: string;
}

export default function PageTree({ driveId, initialTree, mutate: externalMutate, isTrashView = false, searchQuery = '' }: PageTreeProps) {
  const { tree: fetchedTree, isLoading, mutate: internalMutate } = usePageTreeSocket(driveId, isTrashView);
  const tree = initialTree ?? fetchedTree;
  const mutate = externalMutate ?? internalMutate;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [optimisticTree, setOptimisticTree] = useState<TreePage[] | null>(null);
  const [dragState, setDragState] = useState<DragState>({
    overId: null,
    dropPosition: null
  });
  const { expanded: expandedNodes, toggleExpanded } = useTreeState();
  const [createPageInfo, setCreatePageInfo] = useState<{
    isOpen: boolean;
    parentId: string | null;
  }>({ isOpen: false, parentId: null });
  const [expandTimer, setExpandTimer] = useState<NodeJS.Timeout | null>(null);
  
  // File drop handling
  const [isDraggingOverRoot, setIsDraggingOverRoot] = useState(false);
  const [fileDropTarget, setFileDropTarget] = useState<FileDropTarget>({
    nodeId: null,
    dropPosition: null
  });
  
  const {
    isDraggingFiles,
    isUploading,
    uploadProgress,
    handleDragEnter,
    handleDragLeave,
    handleDragOver: handleFileDragOver,
    handleFileDrop
  } = useFileDrop({
    driveId,
    parentId: null,
    onUploadComplete: () => {
      mutate();
    }
  });
  
  // Auto-expand pages when dragging files over them (if they have children)
  useEffect(() => {
    const targetId = isDraggingFiles ? fileDropTarget.nodeId : dragState.overId;
    const targetDropPosition = isDraggingFiles ? fileDropTarget.dropPosition : dragState.dropPosition;
    
    if (targetId && targetDropPosition === 'inside') {
      const currentTree = optimisticTree ?? tree;
      const targetNode = findNodeAndParent(currentTree, targetId)?.node;
      
      // Any page with children can be expanded
      if (targetNode && targetNode.children && targetNode.children.length > 0 && !expandedNodes.has(targetId)) {
        // Clear any existing timer
        if (expandTimer) {
          clearTimeout(expandTimer);
        }
        
        // Set new timer to expand after 500ms
        const timer = setTimeout(() => {
          toggleExpanded(targetId);
        }, 500);
        
        setExpandTimer(timer);
      }
    } else {
      // Clear timer if not hovering over expandable page
      if (expandTimer) {
        clearTimeout(expandTimer);
        setExpandTimer(null);
      }
    }
    
    return () => {
      if (expandTimer) {
        clearTimeout(expandTimer);
      }
    };
  }, [isDraggingFiles, fileDropTarget.nodeId, fileDropTarget.dropPosition, dragState.overId, dragState.dropPosition, tree, optimisticTree, expandedNodes, toggleExpanded, expandTimer]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    })
  );

  const filterTree = (nodes: TreePage[], query: string): TreePage[] => {
   if (!query) return nodes;

   const lowerCaseQuery = query.toLowerCase();

   function filter(items: TreePage[]): TreePage[] {
       return items.reduce<TreePage[]>((acc, item) => {
           const children = item.children ? filter(item.children) : [];
           
           if (item.title.toLowerCase().includes(lowerCaseQuery) || children.length > 0) {
               acc.push({ ...item, children });
           }
           
           return acc;
       }, []);
   }

   return filter(nodes);
  };

  const displayedTree = useMemo(() => {
   const currentTree = optimisticTree ?? tree;
   if (!searchQuery.trim()) return currentTree;
   return filterTree(currentTree, searchQuery);
  }, [optimisticTree, tree, searchQuery]);

  const flattenedItems = useMemo(() => {
    const flatten = (items: TreePage[]): string[] => {
      if (!Array.isArray(items)) {
        return [];
      }
      return items.reduce<string[]>((acc, item) => {
        acc.push(item.id);
        if (item.children && expandedNodes.has(item.id)) {
          acc.push(...flatten(item.children));
        }
        return acc;
      }, []);
    };
    return flatten(displayedTree);
  }, [displayedTree, expandedNodes]);

  const activeNode = useMemo(() => {
    if (!activeId) return null;
    const currentTree = optimisticTree ?? tree; // Search in the original tree
    const result = findNodeAndParent(currentTree, activeId);
    return result?.node || null;
  }, [activeId, optimisticTree, tree]);

  const handleToggleExpand = useCallback((id: string) => {
    toggleExpanded(id);
  }, [toggleExpanded]);

  const handleOpenCreateDialog = useCallback((parentId: string | null) => {
    setCreatePageInfo({ isOpen: true, parentId });
  }, []);

  const handlePageCreated = useCallback(() => {
    mutate();
  }, [mutate]);

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { over, active, delta } = event;
    
    if (!over || !active) {
      setDragState({ overId: null, dropPosition: null });
      return;
    }

    const overId = over.id as string;
    const activeId = active.id as string;
    
    if (overId === activeId) {
      setDragState({ overId: null, dropPosition: null });
      return;
    }

    let dropPosition: DropPosition;
    
    if (delta.x > 30) {
      dropPosition = 'inside';
    } else {
      dropPosition = delta.y > 0 ? 'after' : 'before';
    }

    setDragState({ overId, dropPosition });
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    
    if (!over || !driveId || active.id === over.id || !dragState.dropPosition) {
      setActiveId(null);
      setDragState({ overId: null, dropPosition: null });
      return;
    }

    const currentTree = optimisticTree ?? tree;
    const activeInfo = findNodeAndParent(currentTree, active.id as string);
    const overInfo = findNodeAndParent(currentTree, over.id as string);

    if (!activeInfo || !overInfo) return;

    const { node: activeNode } = activeInfo;
    const { parent: overParent } = overInfo;

    let newTree = removeNode(currentTree, active.id as string);
    let newParentId: string | null;
    let newIndex: number;

    if (dragState.dropPosition === 'inside') {
      newParentId = over.id as string;
      newIndex = 0;
      // Ensure the target node is expanded when dropping inside
      if (!expandedNodes.has(over.id as string)) {
        toggleExpanded(over.id as string);
      }
    } else {
      newParentId = overParent ? overParent.id : driveId;
      const siblings = overParent ? overParent.children : newTree;
      const overIndex = siblings.findIndex((s: TreePage) => s.id === over.id);
      newIndex = dragState.dropPosition === 'after' ? overIndex + 1 : overIndex;
    }
    
    const treeParentId = newParentId === driveId ? null : newParentId;
    newTree = addNode(newTree, activeNode, treeParentId, newIndex);
    setOptimisticTree(newTree);

    const parentChildren = (newParentId && newParentId !== driveId)
      ? findNodeAndParent(newTree, newParentId)?.node.children
      : newTree;
    const finalIndex = parentChildren?.findIndex((item: TreePage) => item.id === active.id) ?? -1;
    
    if (finalIndex === -1) {
      setOptimisticTree(null); // Revert
      return;
    }

    const prev = parentChildren?.[finalIndex - 1];
    const next = parentChildren?.[finalIndex + 1];
    const newPosition = ((prev?.position || 0) + (next?.position || (prev?.position || 0) + 2)) / 2;

    try {
      await fetch('/api/pages/reorder', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageId: active.id,
          newParentId: treeParentId,
          newPosition: newPosition,
        }),
      });
      await mutate();
    } catch (error) {
      console.error("Failed to reorder page:", error);
      setOptimisticTree(null);
    } finally {
      setActiveId(null);
      setDragState({ overId: null, dropPosition: null });
      setOptimisticTree(null);
    }
  };

  const handleDragCancel = () => {
    setActiveId(null);
    setDragState({ overId: null, dropPosition: null });
  };

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
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
      measuring={{
        droppable: {
          strategy: MeasuringStrategy.Always
        }
      }}
    >
      <div 
        className={cn(
          "relative h-full",
          isDraggingFiles && "bg-primary/5"
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleFileDragOver}
        onDrop={(e) => {
          if (isDraggingFiles && fileDropTarget.nodeId && fileDropTarget.dropPosition === 'inside') {
            // Drop on specific page
            e.preventDefault();
            e.stopPropagation();
            handleFileDrop(e as React.DragEvent, fileDropTarget.nodeId);
          } else if (isDraggingFiles && !fileDropTarget.nodeId) {
            // Drop on root
            e.preventDefault();
            e.stopPropagation();
            handleFileDrop(e as React.DragEvent, null);
          }
          setIsDraggingOverRoot(false);
          setFileDropTarget({ nodeId: null, dropPosition: null });
        }}
      >
        <SortableContext items={flattenedItems} strategy={verticalListSortingStrategy}>
          <nav className="px-1 py-2">
            {displayedTree.map(node => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                onToggleExpand={handleToggleExpand}
                isExpanded={expandedNodes.has(node.id)}
                dragState={dragState}
                activeId={activeId}
                onOpenCreateDialog={handleOpenCreateDialog}
                mutate={mutate}
                isTrashView={isTrashView}
                expandedNodes={expandedNodes}
                isDraggingFiles={isDraggingFiles}
                fileDropTarget={fileDropTarget}
                setFileDropTarget={setFileDropTarget}
              />
            ))}
          </nav>
        </SortableContext>
        
        <DragOverlay>
          {activeNode && <DragOverlayItem node={activeNode} />}
        </DragOverlay>

        <CreatePageDialog
          isOpen={createPageInfo.isOpen}
          setIsOpen={(isOpen) => setCreatePageInfo({ ...createPageInfo, isOpen })}
          parentId={createPageInfo.parentId}
          onPageCreated={handlePageCreated}
          driveId={driveId}
        />
        
        {/* File upload overlay - only show when dragging over root, not folders */}
        {isDraggingFiles && isDraggingOverRoot && (
          <div className="absolute inset-0 pointer-events-none z-50">
            <div className="absolute inset-0 bg-primary/10 border-2 border-dashed border-primary rounded-md flex items-center justify-center">
              <div className="text-center">
                <p className="text-sm font-medium">Drop files here to upload to drive root</p>
                <p className="text-xs text-muted-foreground mt-1">Or drop on folders to upload inside them</p>
              </div>
            </div>
          </div>
        )}
        
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
    </DndContext>
  );
}