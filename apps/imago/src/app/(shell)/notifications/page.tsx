import { getViewer } from '@/lib/auth/get-viewer';
import NotificationsPage from '@/retained/components/notifications/notifications-page';

export default async function Page() {
  await getViewer();
  return <NotificationsPage />;
}
