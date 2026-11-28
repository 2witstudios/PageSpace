import { getViewer } from '@/lib/auth/get-viewer';

/** Stage 2: the drive's files list beside the chat. The shell renders the panes; this route owns no object. */
export default async function Page(): Promise<null> {
  await getViewer();
  return null;
}
