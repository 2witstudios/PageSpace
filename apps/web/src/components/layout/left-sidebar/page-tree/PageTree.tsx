"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { FileIcon } from "lucide-react";
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
  displacedNodes?: Set<string>; // Nodes that should animate out of the way
  mousePosition?: { x: number; y: number }; // Track mouse for external drags
  dragStartPos?: { x: number; y: number }; // Track drag start position for delta calculation
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
    dropPosition: null,
    displacedNodes: new Set()
  });
  const { expanded: expandedNodes, toggleExpanded } = useTreeState();
  const [createPageInfo, setCreatePageInfo] = useState<{
    isOpen: boolean;
    parentId: string | null;
  }>({ isOpen: false, parentId: null });
  const [expandTimer, setExpandTimer] = useState<NodeJS.Timeout | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  
  // File upload handling
  const {
    isUploading,
    uploadProgress,
    handleFileDrop
  } = useFileDrop({
    driveId,
    parentId: null,
    onUploadComplete: () => {
      mutate();
    }
  });
  
  // Auto-expand pages when dragging over them (if they have children)
  useEffect(() => {
    if (dragState.overId && dragState.dropPosition === 'inside') {
      const currentTree = optimisticTree ?? tree;
      const targetNode = findNodeAndParent(currentTree, dragState.overId)?.node;
      
      // Any page with children can be expanded
      if (targetNode && targetNode.children && targetNode.children.length > 0 && !expandedNodes.has(dragState.overId)) {
        // Clear any existing timer
        if (expandTimer) {
          clearTimeout(expandTimer);
        }
        
        // Set new timer to expand after 500ms
        const timer = setTimeout(() => {
          toggleExpanded(dragState.overId!);
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
  }, [dragState.overId, dragState.dropPosition, tree, optimisticTree, expandedNodes, toggleExpanded, expandTimer]);

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
        onDragEnter={(e) => {
          // Check if dragging files from outside
          if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault();
            setIsDraggingFiles(true);
            // Capture drag start position
            setDragState(prev => ({
              ...prev,
              dragStartPos: { x: e.clientX, y: e.clientY }
            }));
          }
        }}
        onDragLeave={(e) => {
          // Only reset if leaving the entire container
          if (e.currentTarget === e.target) {
            setIsDraggingFiles(false);
            setDragState({ overId: null, dropPosition: null, displacedNodes: new Set() });
          }
        }}
        onDragOver={(e) => {
          if (isDraggingFiles && dragState.dragStartPos) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            
            // Calculate delta from drag start position (like native @dnd-kit)
            const deltaX = e.clientX - dragState.dragStartPos.x;
            
            // Find which element we're over
            const target = e.target as HTMLElement;
            const treeNode = target.closest('[data-tree-node-id]');
            
            if (treeNode) {
              const nodeId = treeNode.getAttribute('data-tree-node-id');
              const rect = treeNode.getBoundingClientRect();
              const relativeY = e.clientY - rect.top;
              const heightPercent = relativeY / rect.height;
              
              let dropPosition: DropPosition;
              const displacedNodes = new Set<string>();
              
              // Check for "inside" drop first (drag 30px right from start)
              if (deltaX > 30) {
                dropPosition = 'inside';
              } else {
                // Use position within element for before/after
                // Top 40% = before, Bottom 40% = after, Middle 20% = default to after
                if (heightPercent < 0.4) {
                  dropPosition = 'before';
                } else if (heightPercent > 0.6) {
                  dropPosition = 'after';
                } else {
                  // Middle zone - use previous position to prevent flipping
                  dropPosition = dragState.dropPosition || 'after';
                }
              }
                
              // Find nodes that should be displaced only for before/after
              if (dropPosition !== 'inside') {
                const currentTree = optimisticTree ?? tree;
                const targetInfo = findNodeAndParent(currentTree, nodeId!);
                if (targetInfo) {
                  const siblings = targetInfo.parent?.children || currentTree;
                  const targetIndex = siblings.findIndex((s: TreePage) => s.id === nodeId);
                  
                  if (dropPosition === 'before') {
                    // All siblings from target onwards should move down
                    for (let i = targetIndex; i < siblings.length; i++) {
                      displacedNodes.add(siblings[i].id);
                    }
                  } else if (dropPosition === 'after') {
                    // All siblings after target should move down
                    for (let i = targetIndex + 1; i < siblings.length; i++) {
                      displacedNodes.add(siblings[i].id);
                    }
                  }
                }
              }
              
              setDragState(prev => ({ 
                ...prev,
                overId: nodeId, 
                dropPosition, 
                isExternalFile: true,
                displacedNodes,
                mousePosition: { x: e.clientX, y: e.clientY }
              }));
            } else {
              setDragState(prev => ({ 
                ...prev,
                overId: null, 
                dropPosition: null, 
                isExternalFile: true,
                displacedNodes: new Set(),
                mousePosition: { x: e.clientX, y: e.clientY }
              }));
            }
          }
        }}
        onDrop={async (e) => {
          if (isDraggingFiles) {
            e.preventDefault();
            e.stopPropagation();
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
              // Handle file upload based on drop position
              if (dragState.overId) {
                // Dropping on a specific node
                const currentTree = optimisticTree ?? tree;
                const targetInfo = findNodeAndParent(currentTree, dragState.overId);
                
                if (targetInfo) {
                  let parentId: string | null = null;
                  let position: 'before' | 'after' | null = null;
                  let afterNodeId: string | null = null;
                  
                  if (dragState.dropPosition === 'inside') {
                    // Drop inside the target
                    parentId = dragState.overId;
                  } else if (dragState.dropPosition === 'before' || dragState.dropPosition === 'after') {
                    // Drop before/after - use same parent as target
                    parentId = targetInfo.parent?.id || null;
                    position = dragState.dropPosition;
                    afterNodeId = dragState.overId;
                  }
                  
                  // Upload files with position data
                  await handleFileDrop(e as React.DragEvent, parentId, position, afterNodeId);
                }
              } else {
                // Dropping on empty space - add to root
                await handleFileDrop(e as React.DragEvent, null, null, null);
              }
            }
            
            setIsDraggingFiles(false);
            setDragState({ overId: null, dropPosition: null, displacedNodes: new Set() });
          }
        }}
      >
        <SortableContext items={flattenedItems} strategy={verticalListSortingStrategy}>
          <nav className="px-1 py-2 min-h-[200px]">
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
              />
            ))}
            {/* Drop zone indicator for empty space */}
            {isDraggingFiles && !dragState.overId && displayedTree.length === 0 && (
              <div className="flex items-center justify-center py-8 px-4 border-2 border-dashed border-primary/20 rounded-lg bg-primary/5">
                <div className="text-center">
                  <FileIcon className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">Drop files here to upload</p>
                </div>
              </div>
            )}
            {/* Drop indicator at the bottom when dragging over empty space below items */}
            {isDraggingFiles && !dragState.overId && displayedTree.length > 0 && (
              <div className="mt-2 py-2 px-4 border-2 border-dashed border-primary/20 rounded-lg bg-primary/5">
                <p className="text-sm text-muted-foreground text-center">Drop here to add to root</p>
              </div>
            )}
          </nav>
        </SortableContext>
        
        <DragOverlay>
          {activeNode && <DragOverlayItem node={activeNode} />}
        </DragOverlay>
        
        {/* External file drag overlay */}
        {isDraggingFiles && dragState.mousePosition && (
          <div
            className="fixed pointer-events-none z-[9999]"
            style={{
              left: dragState.mousePosition.x + 10,
              top: dragState.mousePosition.y - 10,
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
        
        {/* File upload overlay - show drop position */}
        {isDraggingFiles && dragState.overId && (
          <div className="absolute inset-0 pointer-events-none z-50">
            {/* Visual indicator will be handled by TreeNode's existing drop indicators */}
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