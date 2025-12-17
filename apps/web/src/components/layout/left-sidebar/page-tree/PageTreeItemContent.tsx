"use client";

import { CSSProperties, forwardRef, MouseEvent, KeyboardEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ChevronRight,
  Plus,
  GripVertical,
} from "lucide-react";
import { TreePage } from "@/hooks/usePageTree";
import { PageTypeIcon } from "@/components/common/PageTypeIcon";
import { cn } from "@/lib/utils";

export type DropPosition = "before" | "after" | "inside" | null;

export interface PageTreeItemContentProps {
  item: TreePage;
  depth: number;
  isSelected?: boolean;
  isActive?: boolean; // Currently being dragged
  isDragOverlay?: boolean; // Rendered inside DragOverlay
  showDropIndicator?: boolean;
  dropPosition?: DropPosition;
  indicatorDepth?: number;
  isExpanded?: boolean;
  hasChildren?: boolean;
  isFavorite?: boolean;
  isHovered?: boolean;
  isTrashView?: boolean;
  style?: CSSProperties;
  // Event handlers - optional for presentational use
  onToggleExpand?: (id: string) => void;
  onOpenCreateDialog?: (parentId: string | null) => void;
  onRename?: () => void;
  onTrash?: () => void;
  onRestore?: () => void;
  onPermanentDelete?: () => void;
  onFavoriteToggle?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onClick?: (e: MouseEvent) => void;
  onContextMenu?: (e: MouseEvent) => void;
  // For selection indicator click/keypress
  onSelectionClick?: (e: MouseEvent | KeyboardEvent) => void;
  // Drag handle props (optional - only when draggable)
  dragHandleProps?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listeners?: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attributes?: Record<string, any>;
  };
}

export const PageTreeItemContent = forwardRef<HTMLDivElement, PageTreeItemContentProps>(
  function PageTreeItemContent(
    {
      item,
      depth,
      isSelected = false,
      isActive = false,
      isDragOverlay = false,
      showDropIndicator = false,
      dropPosition = null,
      indicatorDepth,
      isExpanded = false,
      hasChildren = false,
      isFavorite: _isFavorite = false,
      isHovered = false,
      isTrashView = false,
      style,
      onToggleExpand,
      onOpenCreateDialog,
      onRename: _onRename,
      onTrash: _onTrash,
      onRestore: _onRestore,
      onPermanentDelete: _onPermanentDelete,
      onFavoriteToggle: _onFavoriteToggle,
      onMouseEnter,
      onMouseLeave,
      onClick,
      onContextMenu,
      onSelectionClick,
      dragHandleProps,
    },
    ref
  ) {
    const params = useParams();
    const linkHref = `/dashboard/${params.driveId}/${item.id}`;
    const effectiveIndicatorDepth = indicatorDepth ?? depth;

    // Silence unused vars - passed for interface completeness, handled by context menu
    void _isFavorite;
    void _onRename;
    void _onTrash;
    void _onRestore;
    void _onPermanentDelete;
    void _onFavoriteToggle;

    // Compute if children exist from item
    const itemHasChildren = hasChildren || (item.children && item.children.length > 0);

    return (
      <div
        ref={ref}
        style={style}
        className={cn(
          "relative",
          isActive && !isDragOverlay && "z-50 opacity-50",
          isDragOverlay && "opacity-95 shadow-lg"
        )}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onContextMenu={onContextMenu}
      >
        {/* Drop indicator - BEFORE */}
        {showDropIndicator && dropPosition === "before" && (
          <div className="relative">
            <div
              className="absolute left-0 right-0 h-0.5 bg-primary -top-[1px] pointer-events-none z-10"
              style={{ left: `${effectiveIndicatorDepth * 24 + 8}px` }}
            />
            <div className="h-0.5 w-full" />
          </div>
        )}

        <div
          data-tree-node-id={item.id}
          className={cn(
            "group flex items-center px-1 py-1.5 rounded-lg transition-all duration-200",
            showDropIndicator && dropPosition === "inside" &&
              "bg-primary/10 dark:bg-primary/20 ring-2 ring-primary ring-inset",
            !isActive && !showDropIndicator &&
              "hover:bg-gray-100 dark:hover:bg-gray-800",
            params.pageId === item.id && !isSelected && "bg-gray-200 dark:bg-gray-700",
            isSelected && "bg-blue-100 dark:bg-blue-900/40 ring-1 ring-blue-400 dark:ring-blue-600"
          )}
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
          onClick={onClick}
        >
          {/* Selection indicator / checkbox area */}
          <button
            type="button"
            data-selection-checkbox
            className={cn(
              "flex items-center justify-center w-5 h-5 mr-0.5 rounded transition-opacity",
              "bg-transparent border-none p-0 cursor-pointer",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1",
              isSelected || isHovered ? "opacity-100" : "opacity-0"
            )}
            onClick={onSelectionClick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelectionClick?.(e);
              }
            }}
            aria-pressed={isSelected}
            aria-label={isSelected ? `Deselect ${item.title}` : `Select ${item.title}`}
          >
            <div
              className={cn(
                "w-3.5 h-3.5 rounded border-2 transition-colors flex items-center justify-center",
                isSelected
                  ? "bg-blue-500 border-blue-500"
                  : "border-gray-400 hover:border-gray-500"
              )}
            >
              {isSelected && (
                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          </button>

          {/* Expand/Collapse Chevron */}
          {itemHasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.(item.id);
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
          ) : (
            <div className="w-6" /> // Spacer for alignment
          )}

          {/* Icon / Drag Handle */}
          <div
            {...(dragHandleProps?.listeners || {})}
            {...(dragHandleProps?.attributes || {})}
            className={cn(
              "p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700",
              dragHandleProps?.listeners && "cursor-grab active:cursor-grabbing"
            )}
          >
            <PageTypeIcon
              type={item.type}
              isTaskLinked={item.isTaskLinked}
              className={cn(
                "h-4 w-4 flex-shrink-0",
                itemHasChildren ? "text-primary" : "text-gray-500"
              )}
            />
          </div>

          {/* Title - Click to Navigate */}
          <Link
            href={linkHref}
            className="flex-1 min-w-0 ml-1.5 truncate text-sm font-medium text-gray-900 dark:text-gray-100 hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {item.title}
          </Link>

          {/* Action Buttons - visible on hover */}
          <div
            className={cn(
              "flex items-center gap-1 ml-2 transition-opacity duration-200",
              isHovered && !isDragOverlay ? "opacity-100" : "opacity-0"
            )}
          >
            {!isTrashView && (
              <button
                className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenCreateDialog?.(item.id);
                }}
                aria-label="Add child page"
              >
                <Plus className="h-3 w-3 text-gray-500" />
              </button>
            )}
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
              style={{ left: `${effectiveIndicatorDepth * 24 + 8}px` }}
            />
          </div>
        )}
      </div>
    );
  }
);

// Compact version for DragOverlay with multiple items
export interface DragOverlayContentProps {
  items: TreePage[];
  totalCount: number;
}

export function DragOverlayContent({ items, totalCount }: DragOverlayContentProps) {
  const firstItem = items[0];
  if (!firstItem) return null;

  if (totalCount === 1) {
    // Single item drag - show the full item
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-2 min-w-[200px]">
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-gray-400" />
          <PageTypeIcon
            type={firstItem.type}
            isTaskLinked={firstItem.isTaskLinked}
            className="h-4 w-4 text-gray-500"
          />
          <span className="text-sm font-medium truncate">{firstItem.title}</span>
        </div>
      </div>
    );
  }

  // Multi-item drag - show stacked preview with count
  return (
    <div className="relative">
      {/* Background cards for stacked effect */}
      <div className="absolute top-1 left-1 w-full h-full bg-gray-200 dark:bg-gray-700 rounded-lg opacity-60" />
      <div className="absolute top-0.5 left-0.5 w-full h-full bg-gray-100 dark:bg-gray-600 rounded-lg opacity-80" />

      {/* Main card */}
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-2 min-w-[200px]">
        <div className="flex items-center gap-2">
          <GripVertical className="h-4 w-4 text-gray-400" />
          <PageTypeIcon
            type={firstItem.type}
            isTaskLinked={firstItem.isTaskLinked}
            className="h-4 w-4 text-gray-500"
          />
          <span className="text-sm font-medium truncate">{firstItem.title}</span>
          <span className="ml-auto bg-blue-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">
            {totalCount}
          </span>
        </div>
      </div>
    </div>
  );
}
