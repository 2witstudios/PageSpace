import { getViewer } from '@/lib/auth/get-viewer';
import { DriveSettingsOverview } from '@/ui/settings/settings-overview/settings-overview';

export default async function Page({ params }: { params: Promise<{ driveId: string }> }) {
  const [{ driveId }] = await Promise.all([params, getViewer()]);
  return <DriveSettingsOverview driveId={driveId} />;
}
