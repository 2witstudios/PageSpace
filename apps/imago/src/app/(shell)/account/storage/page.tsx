import { getViewer } from '@/lib/auth/get-viewer';
import { AccountStorage } from '@/ui/settings/account-storage/account-storage';

export default async function Page() {
  const viewer = await getViewer();
  return <AccountStorage isAdmin={viewer.role === 'admin'} />;
}
