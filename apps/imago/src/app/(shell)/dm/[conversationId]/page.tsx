import { getViewer } from '@/lib/auth/get-viewer';
import DM from '@/retained/app/dashboard/dms/[conversationId]/page';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { ConversationObject } from '@/ui/messages/conversation-object/conversation-object';

export default async function Page({ params }: { readonly params: Promise<{ conversationId: string }> }) {
  await getViewer();
  const { conversationId } = await params;
  return (
    <ConversationObject conversationId={conversationId}>
      <RetainedSurface>
        <DM />
      </RetainedSurface>
    </ConversationObject>
  );
}
