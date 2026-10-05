import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { ChannelThread } from '@/ui/messages/thread-view/channel-thread';

/** Stage 3: the list, the open channel and the fixed chat. The route renders only the object slot's content. */
export default async function Page({
  params,
}: {
  readonly params: Promise<{ readonly driveId: string; readonly pageId: string }>;
}): Promise<ReactNode> {
  const [{ driveId, pageId }, viewer] = await Promise.all([params, getViewer()]);
  return <ChannelThread driveId={driveId} pageId={pageId} viewerId={viewer.userId} />;
}
