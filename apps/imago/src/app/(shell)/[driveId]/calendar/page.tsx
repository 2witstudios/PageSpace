import { getViewer } from '@/lib/auth/get-viewer';
import { CalendarMiddle } from '@/ui/tools/calendar/calendar-middle';
import { UserCalendarMiddle } from '@/ui/tools/user-calendar/user-calendar-middle';
import { HomeScoped } from '@/ui/frame/drives/home-scoped';

export default async function Page({ params }: { readonly params: Promise<{ readonly driveId: string }> }) {
  const { driveId } = await params;
  await getViewer();
  return <HomeScoped driveId={driveId} home={<UserCalendarMiddle />} drive={<CalendarMiddle driveId={driveId} />} />;
}
