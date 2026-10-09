import { getViewer } from '@/lib/auth/get-viewer';
import DriveSettings from '@/retained/app/dashboard/[driveId]/settings/page';
import { DriveSettingsObject } from '@/ui/settings/drive-settings/drive-settings';

export default async function Page({ params }: { params: Promise<{ driveId: string }> }) {
  const [{ driveId }] = await Promise.all([params, getViewer()]);
  return <><DriveSettings /><DriveSettingsObject driveId={driveId} /></>;
}
