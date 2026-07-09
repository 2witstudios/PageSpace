"use client"

import * as ResizablePrimitive from "react-resizable-panels"
import { cn } from "@/lib/utils"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

interface ResizableHandleProps extends ResizablePrimitive.SeparatorProps {
  /** Keeps the center seam faintly visible at rest instead of fully
   * transparent. Opt in per-surface (e.g. chrome-free layouts where no
   * sibling border/card gives the seam away independently) — the global
   * default stays hover-only so every other resizable split in the app is
   * unaffected. */
  visibleAtRest?: boolean;
}

function ResizableHandle({
  className,
  visibleAtRest = false,
  ...props
}: ResizableHandleProps) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-1.5 flex-shrink-0 cursor-col-resize items-center justify-center",
        "bg-transparent transition-colors duration-150",
        "hover:bg-sidebar-border/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        "aria-[orientation=horizontal]:h-1.5 aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:cursor-row-resize",
        "group",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-sidebar-border transition-opacity duration-150 group-hover:opacity-100 group-data-[separator=active]:opacity-100 group-data-[separator=active]:bg-primary",
          visibleAtRest ? "opacity-60" : "opacity-0"
        )}
      />
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
export { useDefaultLayout } from "react-resizable-panels"
