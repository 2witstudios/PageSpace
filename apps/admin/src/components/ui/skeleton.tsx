import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("bg-accent animate-pulse rounded-md", className)}
      {...props}
    />
  )
}

interface SkeletonMessageBubbleProps {
  /** Variant determines positioning and subtle styling differences */
  variant: "user" | "assistant"
  /** Custom widths for the text lines (e.g., ["w-3/4", "w-1/2"]) */
  lineWidths?: string[]
  /** Additional className for the container */
  className?: string
}

/**
 * Skeleton component for chat message bubbles
 * Supports both user and assistant message styles with consistent theming
 */
function SkeletonMessageBubble({
  variant,
  lineWidths = ["w-3/4", "w-1/2"],
  className,
}: SkeletonMessageBubbleProps) {
  const isUser = variant === "user"

  return (
    <div
      data-slot="skeleton-message-bubble"
      className={cn(
        "p-3 rounded-lg bg-accent animate-pulse",
        isUser ? "ml-8" : "mr-8",
        className
      )}
    >
      <div className="space-y-2">
        {lineWidths.map((width, index) => (
          <Skeleton
            key={index}
            className={cn(
              // First line slightly taller (title/heading)
              index === 0 ? "h-4" : "h-3",
              width
            )}
          />
        ))}
      </div>
    </div>
  )
}

interface SkeletonCardProps {
  /** Height of the card body content area (e.g., "h-24", "h-32") */
  bodyHeight?: string
  /** Whether to show a header/title skeleton at the top */
  showHeader?: boolean
  /** Width of the header title skeleton (e.g., "w-1/3", "w-48") */
  headerWidth?: string
  /** Additional className for the container */
  className?: string
}

/**
 * Skeleton component for card-shaped content
 * Matches the rounded corners and structure of the Card component
 */
function SkeletonCard({
  bodyHeight = "h-24",
  showHeader = false,
  headerWidth = "w-1/3",
  className,
}: SkeletonCardProps) {
  return (
    <div
      data-slot="skeleton-card"
      className={cn(
        "rounded-xl border bg-card p-6 animate-pulse",
        className
      )}
    >
      {showHeader && (
        <div className="mb-6">
          <Skeleton className={cn("h-5", headerWidth)} />
        </div>
      )}
      <Skeleton className={cn("w-full", bodyHeight)} />
    </div>
  )
}

interface SkeletonListItemProps {
  /** Whether to show an icon placeholder on the left */
  showIcon?: boolean
  /** Size of the icon placeholder (e.g., "h-4 w-4", "h-5 w-5") */
  iconSize?: string
  /** Whether to show a secondary text line below the primary */
  showSecondaryText?: boolean
  /** Width of the primary text skeleton (e.g., "w-3/4", "w-32") */
  primaryWidth?: string
  /** Width of the secondary text skeleton (e.g., "w-1/2", "w-24") */
  secondaryWidth?: string
  /** Additional className for the container */
  className?: string
}

/**
 * Skeleton component for list items
 * Supports optional icon placeholder and secondary text line
 */
function SkeletonListItem({
  showIcon = false,
  iconSize = "h-4 w-4",
  showSecondaryText = false,
  primaryWidth = "w-3/4",
  secondaryWidth = "w-1/2",
  className,
}: SkeletonListItemProps) {
  return (
    <div
      data-slot="skeleton-list-item"
      className={cn(
        "flex items-center gap-2 p-2 animate-pulse",
        className
      )}
    >
      {showIcon && (
        <Skeleton className={cn("rounded-md shrink-0", iconSize)} />
      )}
      <div className="flex-1 min-w-0 space-y-1.5">
        <Skeleton className={cn("h-4", primaryWidth)} />
        {showSecondaryText && (
          <Skeleton className={cn("h-3", secondaryWidth)} />
        )}
      </div>
    </div>
  )
}

export { Skeleton, SkeletonMessageBubble, SkeletonCard, SkeletonListItem }
