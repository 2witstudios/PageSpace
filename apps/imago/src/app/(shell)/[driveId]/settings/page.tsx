import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { DriveSettingsObject } from '@/ui/settings/drive-settings/drive-settings';

type Props = { readonly params: Promise<{ driveId: string }> };

/**
 * Drive settings: an object beside the chat, with no list. The drive gate
 * above has already settled that the viewer can open the drive; the route
 * renders only the object slot's content.
 */
export default async function Page({ params }: Props): Promise<ReactNode> {
  await getViewer();
  const { driveId } = await params;
  return <DriveSettingsObject driveId={driveId} />;
}
