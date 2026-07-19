"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/index";
import { ArrowDownIcon } from "lucide-react";
import { useCallback, type ComponentProps, useRef, useEffect, useState, type RefObject } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    !isAtBottom && (
      <Button
        className={cn(
          "absolute bottom-4 left-[50%] translate-x-[-50%] rounded-full",
          className
        )}
        onClick={handleScrollToBottom}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <ArrowDownIcon className="size-4" />
      </Button>
    )
  );
};

/**
 * Hook to access the scroll element ref from use-stick-to-bottom context.
 * Used for integrating virtualized lists with the pinned scroll behavior.
 *
 * Note: The scrollRef may not be immediately available on first render,
 * so consumers should handle null cases gracefully.
 */
export function useConversationScrollRef(): RefObject<HTMLElement | null> {
  const { scrollRef } = useStickToBottomContext();
  const fallbackRef = useRef<HTMLElement | null>(null);
  const [, forceUpdate] = useState({});

  // Force re-render when scrollRef becomes available
  useEffect(() => {
    if (scrollRef?.current && !fallbackRef.current) {
      fallbackRef.current = scrollRef.current;
      forceUpdate({});
    }
  }, [scrollRef]);

  return scrollRef ?? fallbackRef;
}
