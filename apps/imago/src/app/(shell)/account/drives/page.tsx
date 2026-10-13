import { getViewer } from '@/lib/auth/get-viewer';
import { AccountDrives } from '@/ui/settings/account-drives/account-drives';

export default async function Page() {
  await getViewer();
  return <AccountDrives />;
}
