import { getViewer } from '@/lib/auth/get-viewer';
import { AccountOrganizationsSection } from '@/retained/components/orgs/AccountOrganizationsSection';

export default async function Page() {
  await getViewer();
  return <div className="mx-auto w-full max-w-settings px-settings-x py-settings-y"><AccountOrganizationsSection /></div>;
}
