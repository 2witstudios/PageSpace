import { getViewer } from '@/lib/auth/get-viewer';
import { AccountOverview } from '@/ui/settings/account-overview/account-overview';

export default async function Page() {
  await getViewer();
  return <AccountOverview />;
}
