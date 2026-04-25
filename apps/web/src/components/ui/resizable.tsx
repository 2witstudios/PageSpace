"use client"

import * as ResizablePrimitive from "react-resizable-panels"
export { useDefaultLayout } from "react-resizable-panels"

import { cn } from "@/lib/utils/index"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
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
  ...props
}: ResizablePrimitive.SeparatorProps) {
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
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-sidebar-border opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-data-[resize-handle-state=drag]:opacity-100 group-data-[resize-handle-state=drag]:bg-primary" />
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
