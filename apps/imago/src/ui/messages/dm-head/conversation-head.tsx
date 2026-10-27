'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { UserSafetyMenu } from '@/retained/components/moderation/UserSafetyMenu';
import { useDirectThreads } from '../use-messages/use-messages';
import { DmHead } from './dm-head';

export type ConversationHeadProps = {
  readonly conversationId: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
};

/**
 * The object head of an open DM (C-DM-Conversation): "Direct messages › <name>", Conversation
 * options and the shell's controls, in the one 48px head the column draws. The name comes from the
 * conversations list the DM pane already holds.
 */
export function ConversationHead({ conversationId, leading, trailing }: ConversationHeadProps): ReactNode {
  const router = useRouter();
  const { threads } = useDirectThreads();
  const thread = threads?.find((entry) => entry.id === conversationId);
  const title = thread?.name ?? 'Conversation';
  const options =
    thread?.otherUserId == null ? undefined : (
      <UserSafetyMenu
        userId={thread.otherUserId}
        displayName={thread.name}
        conversationId={conversationId}
        triggerLabel="Conversation options"
        onBlocked={() => router.push('/dm')}
      />
    );
  return <DmHead title={title} options={options} leading={leading} trailing={trailing} />;
}
