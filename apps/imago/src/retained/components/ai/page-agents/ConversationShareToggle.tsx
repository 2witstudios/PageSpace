import { cn } from '@/retained/lib/utils';

interface ConversationShareToggleProps {
  /** The conversation's title, named in the switch's accessible label ("Share <title>"). */
  title: string;
  /** Whether the conversation is shared (multiplayer) with everyone on the page. */
  isShared: boolean;
  /** Whether the current user owns the conversation (only owners may change sharing). */
  isOwner: boolean;
  /** Flip the share state. Only called for owners. */
  onToggle: () => void;
}

/**
 * The "Shared" switch for an AI conversation (C-Files-AiChat History).
 *
 * Owners get a real switch (role="switch") labelled "Share <title>". Non-owners
 * viewing a shared conversation get a read-only "Shared" word; a private one from
 * someone else draws nothing, because there is nothing they can do with it.
 */
export function ConversationShareToggle({
  title,
  isShared,
  isOwner,
  onToggle,
}: ConversationShareToggleProps) {
  if (isOwner) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Shared
        <button
          type="button"
          role="switch"
          aria-checked={isShared}
          aria-label={`Share ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className={cn(
            'relative h-5 w-9 shrink-0 cursor-pointer rounded-full border-0 p-0 transition-colors',
            isShared ? 'bg-primary' : 'bg-muted',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-0.5 size-4 rounded-full bg-background shadow transition-[left]',
              isShared ? 'left-[18px]' : 'left-0.5',
            )}
          />
        </button>
      </span>
    );
  }

  if (isShared) {
    return <span className="px-1 text-xs text-muted-foreground">Shared</span>;
  }

  return null;
}
