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

export { Skeleton, SkeletonMessageBubble, SkeletonCard }
