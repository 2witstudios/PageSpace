import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { renderObjectPlaceholder } from '@/ui/frame/shell/object-placeholder';

/** Stage 3: the list, the open channel and the fixed chat. The route renders only the object slot's content. */
export default async function Page(): Promise<ReactNode> {
  await getViewer();
  return renderObjectPlaceholder('Channel');
}
