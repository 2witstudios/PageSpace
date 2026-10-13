import { getViewer } from '@/lib/auth/get-viewer';
import { CalendarMiddle } from '@/ui/tools/calendar/calendar-middle';

export default async function Page({ params }: { readonly params: Promise<{ readonly driveId: string }> }) {
  const { driveId } = await params;
  await getViewer();
  return <CalendarMiddle driveId={driveId} />;
}
