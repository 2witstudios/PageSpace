import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { renderObjectPlaceholder } from '@/ui/frame/shell/object-placeholder';

/** The account: an object beside the chat, with no list. The route renders only the object slot's content. */
export default async function Page(): Promise<ReactNode> {
  await getViewer();
  return renderObjectPlaceholder('Account');
}
