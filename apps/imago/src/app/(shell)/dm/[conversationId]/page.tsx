import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { renderObjectPlaceholder } from '@/ui/frame/shell/object-placeholder';

/** Stage 3, user-level: the list, the open conversation and the fixed chat. The route renders only the object slot's content. */
export default async function Page(): Promise<ReactNode> {
  await getViewer();
  return renderObjectPlaceholder('Conversation');
}
