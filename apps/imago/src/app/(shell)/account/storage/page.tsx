import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/get-viewer';

export default async function Page() {
  await getViewer();
  redirect('/account/usage');
}
