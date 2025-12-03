"use client";

import { CSSProperties, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { UniqueIdentifier } from "@dnd-kit/core";
import { Projection } from "@/lib/tree/sortable-tree";

interface HandleProps {
  ref: (element: HTMLElement | null) => void;
  listeners: ReturnType<typeof useSortable>["listeners"];
  attributes: ReturnType<typeof useSortable>["attributes"];
}

interface WrapperProps {
  ref: (element: HTMLElement | null) => void;
  style: CSSProperties;
}

export interface SortableTreeItemProps {
  id: UniqueIdentifier;
  depth: number;
  indentationWidth: number;
  isActive: boolean;
  isOver: boolean;
  projected: Projection | null;
  children: (handleProps: HandleProps, wrapperProps: WrapperProps) => ReactNode;
}

export function SortableTreeItem({
  id,
  depth,
  indentationWidth,
  /* eslint-disable @typescript-eslint/no-unused-vars */
  isActive, // Passed through to children via render props
  isOver,   // Passed through to children via render props
  /* eslint-enable @typescript-eslint/no-unused-vars */
  projected,
  children,
}: SortableTreeItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    data: { depth },
  });

  // During drag, use projected depth for visual feedback
  const visualDepth = isDragging && projected ? projected.depth : depth;

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    paddingLeft: visualDepth * indentationWidth,
    opacity: isDragging ? 0.5 : 1,
    position: "relative",
  };

  const handleProps: HandleProps = {
    ref: setActivatorNodeRef,
    listeners,
    attributes,
  };

  const wrapperProps: WrapperProps = {
    ref: setNodeRef,
    style,
  };

  return <>{children(handleProps, wrapperProps)}</>;
}
