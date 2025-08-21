"use client";

import { useState, useMemo, useCallback } from "react";
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

export type DropPosition = 'before' | 'after' | 'inside' | null;

export interface DragState {
  overId: string | null;
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
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set());
  const [createPageInfo, setCreatePageInfo] = useState<{
    isOpen: boolean;
    parentId: string | null;
  }>({ isOpen: false, parentId: null });

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
        if (item.children && !collapsedNodes.has(item.id)) {
          acc.push(...flatten(item.children));
        }
        return acc;
      }, []);
    };
    return flatten(displayedTree);
  }, [displayedTree, collapsedNodes]);

  const activeNode = useMemo(() => {
    if (!activeId) return null;
    const currentTree = optimisticTree ?? tree; // Search in the original tree
    const result = findNodeAndParent(currentTree, activeId);
    return result?.node || null;
  }, [activeId, optimisticTree, tree]);

  const handleCollapse = useCallback((id: string) => {
    setCollapsedNodes(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

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
      setCollapsedNodes(prev => {
        const next = new Set(prev);
        next.delete(over.id as string);
        return next;
      });
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
      <SortableContext items={flattenedItems} strategy={verticalListSortingStrategy}>
        <nav className="px-1 py-2">
          {displayedTree.map(node => (
            <TreeNode
              key={node.id}
              node={node}
              depth={0}
              onCollapse={handleCollapse}
              isCollapsed={collapsedNodes.has(node.id)}
              dragState={dragState}
              activeId={activeId}
              onOpenCreateDialog={handleOpenCreateDialog}
              mutate={mutate}
              isTrashView={isTrashView}
              collapsedNodes={collapsedNodes}
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
   </DndContext>
  );
}