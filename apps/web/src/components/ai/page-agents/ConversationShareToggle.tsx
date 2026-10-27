import { Lock, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ConversationShareToggleProps {
  /** Whether the conversation is shared (multiplayer) with everyone on the page. */
  isShared: boolean;
  /** Whether the current user owns the conversation (only owners may change sharing). */
  isOwner: boolean;
  /** Flip the share state. Only called for owners. */
  onToggle: () => void;
}

/**
 * The "Private" / "Shared" pill for an AI conversation.
 *
 * Owners get an interactive Lock/Users toggle; non-owners viewing a shared
 * conversation get a read-only "Shared" indicator. Used in both the chat-screen
 * header and the History tab's conversation cards so the two stay in lockstep.
 */
export function ConversationShareToggle({
  isShared,
  isOwner,
  onToggle,
}: ConversationShareToggleProps) {
  if (isOwner) {
    return (
      <Button
        variant={isShared ? 'secondary' : 'ghost'}
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title={isShared ? 'Make private' : 'Share with everyone on this page'}
        className="h-7 px-2 gap-1 text-xs"
      >
        {isShared ? (
          <>
            <Users className="h-3 w-3" />
            Shared
          </>
        ) : (
          <>
            <Lock className="h-3 w-3" />
            Private
          </>
        )}
      </Button>
    );
  }

  if (isShared) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground px-1">
        <Users className="h-3 w-3" />
        Shared
      </span>
    );
  }

  return null;
}
