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

export { Skeleton, SkeletonMessageBubble }
