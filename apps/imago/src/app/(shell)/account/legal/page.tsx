import RetainedPage from '@/retained/app/settings/legal/oss-licenses/page';
import type { ComponentProps } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';

/** The Legal nav entry: the open-source licenses screen, the same content as /account/legal/oss-licenses. */
export default async function Page(props: ComponentProps<typeof RetainedPage> & object) {
  await getViewer();
  return <RetainedPage {...props} />;
}
