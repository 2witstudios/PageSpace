import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { renderObjectPlaceholder } from '@/ui/frame/shell/object-placeholder';
import { ConversationObject } from '@/ui/messages/conversation-object/conversation-object';

type Props = { readonly params: Promise<{ conversationId: string }> };

/**
 * Stage 3, user-level: the list, the open conversation and the fixed chat.
 * The route renders only the object slot's content, behind the gate that
 * draws not-found for a conversation the viewer is not part of.
 */
export default async function Page({ params }: Props): Promise<ReactNode> {
  const [{ conversationId }] = await Promise.all([params, getViewer()]);
  return <ConversationObject conversationId={conversationId}>{renderObjectPlaceholder('Conversation')}</ConversationObject>;
}
