import { Suspense } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { ActivityDashboard } from '@/retained/components/activity';

/** Your activity (C-Account-Activity): the user's change log in the account settings chrome. */
export default async function Page() {
  await getViewer();
  return (
    <Suspense fallback={null}>
      <ActivityDashboard context="user" variant="settings" />
    </Suspense>
  );
}
