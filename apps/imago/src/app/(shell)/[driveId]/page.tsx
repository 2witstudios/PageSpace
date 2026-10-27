import { getViewer } from '@/lib/auth/get-viewer';

/** A drive's chat: the rail and a chat that owns the rest of the frame. The shell renders the panes; this route owns no object. */
export default async function Page(): Promise<null> {
  await getViewer();
  return null;
}
