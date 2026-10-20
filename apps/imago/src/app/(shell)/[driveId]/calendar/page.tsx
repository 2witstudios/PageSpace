import { getViewer } from '@/lib/auth/get-viewer';

/** The tool's pane beside the chat. The shell renders the panes; the pane opens the tool's screen as the object. */
export default async function Page(): Promise<null> {
  await getViewer();
  return null;
}
