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

function ResizableHandle({
  className,
  variant = "default",
  ...props
}: ResizablePrimitive.SeparatorProps & { variant?: "default" | "chrome-free" }) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      data-variant={variant}
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
      {/* chrome-free panes (e.g. Terminal) strip every other seam cue, so
          their handle must stay faintly visible at rest — everywhere else
          the resting opacity-0 default is correct because sibling
          borders/cards already show the seam.
          Sized (not absolute-positioned) so the parent's flex centering
          handles both orientations — a fixed absolute/translate line was
          hardcoded vertical and broke for orientation="vertical" groups. */}
      <div
        // Decoration, not an affordance — the seam must not be pinned visible on touch.
        data-hover-only=""
        className={cn(
          "h-full w-px bg-sidebar-border transition-opacity duration-150",
          "group-aria-[orientation=horizontal]:h-px group-aria-[orientation=horizontal]:w-full",
          "group-hover:opacity-100 group-data-[separator=active]:opacity-100 group-data-[separator=active]:bg-primary",
          variant === "chrome-free" ? "opacity-60" : "opacity-0"
        )}
      />
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
export { useDefaultLayout } from "react-resizable-panels"
