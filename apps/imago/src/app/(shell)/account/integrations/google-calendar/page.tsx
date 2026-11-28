import type { ReactNode } from 'react';
import type { ComponentProps } from 'react';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getViewer } from '@/lib/auth/get-viewer';
import RetainedPage from '@/retained/app/settings/integrations/google-calendar/page';
import { renderNotFound } from '@/ui/frame/not-found/not-found.render';

/** Google Calendar is an external service, so an on-prem build has no such screen. */
export default async function Page(props: ComponentProps<typeof RetainedPage> & object): Promise<ReactNode> {
  await getViewer();
  if (isOnPrem()) {
    return renderNotFound({ title: 'Page not found', detail: 'Google Calendar is not available on this deployment.', homeHref: null });
  }
  return <RetainedPage {...props} />;
}
