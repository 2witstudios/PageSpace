import { getViewer } from '@/lib/auth/get-viewer';
import { CalendarMiddle } from '@/ui/tools/calendar/calendar-middle';
import { UserCalendarMiddle } from '@/ui/tools/user-calendar/user-calendar-middle';
import { SectionScoped } from '@/ui/frame/drives/section-scoped';

export default async function Page({ params }: { readonly params: Promise<{ readonly driveId: string }> }) {
  const { driveId } = await params;
  await getViewer();
  return <SectionScoped section="calendar" driveId={driveId} all={<UserCalendarMiddle />} drive={<CalendarMiddle driveId={driveId} />} />;
}
