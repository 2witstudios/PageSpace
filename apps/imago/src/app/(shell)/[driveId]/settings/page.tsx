import { getViewer } from '@/lib/auth/get-viewer';

/** The settings nav beside the chat. The shell renders the panes; a row opens its screen as the object. */
export default async function Page(): Promise<null> {
  await getViewer();
  return null;
}
