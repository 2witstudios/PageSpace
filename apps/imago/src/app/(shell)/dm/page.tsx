import { getViewer } from '@/lib/auth/get-viewer';

/** Stage 2, user-level: the messages list with no drive. The shell renders the panes; this route owns no object. */
export default async function Page(): Promise<null> {
  await getViewer();
  return null;
}
