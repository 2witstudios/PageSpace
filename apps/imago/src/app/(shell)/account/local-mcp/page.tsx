import RetainedPage from '@/retained/app/settings/local-mcp/page';
import type { ComponentProps } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';

export default async function Page(props: ComponentProps<typeof RetainedPage> & object) {
  await getViewer();
  return <RetainedPage {...props} />;
}
