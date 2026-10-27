import { getViewer } from '@/lib/auth/get-viewer';
import { AccountTrash } from '@/ui/settings/account-trash/account-trash';

export default async function Page() {
  const viewer = await getViewer();
  return <AccountTrash viewerId={viewer.userId} />;
}
