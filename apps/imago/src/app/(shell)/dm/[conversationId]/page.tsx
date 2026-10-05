import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { ConversationObject } from '@/ui/messages/conversation-object/conversation-object';
import { DmThread } from '@/ui/messages/thread-view/dm-thread';

type Props = { readonly params: Promise<{ readonly conversationId: string }> };

/**
 * Stage 3, user-level: the list, the open conversation and the fixed chat.
 * The route renders only the object slot's content: the DM thread, behind
 * the gate that draws not-found for a conversation the viewer is not part of.
 */
export default async function Page({ params }: Props): Promise<ReactNode> {
  const [{ conversationId }, viewer] = await Promise.all([params, getViewer()]);
  return (
    <ConversationObject conversationId={conversationId}>
      <DmThread conversationId={conversationId} viewerId={viewer.userId} />
    </ConversationObject>
  );
}
