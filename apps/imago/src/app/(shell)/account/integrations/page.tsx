import type { ReactNode } from 'react';
import type { ComponentProps } from 'react';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { getViewer } from '@/lib/auth/get-viewer';
import RetainedPage from '@/retained/app/settings/integrations/page';
import { renderNotFound } from '@/ui/frame/not-found/not-found.render';

/**
 * Integrations are OAuth and external services, so an on-prem build has no such screen: the
 * route is not found there rather than an error the retained page would show after a 404.
 */
export default async function Page(props: ComponentProps<typeof RetainedPage> & object): Promise<ReactNode> {
  await getViewer();
  if (isOnPrem()) {
    return renderNotFound({ title: 'Page not found', detail: 'Integrations are not available on this deployment.', homeHref: null });
  }
  return <RetainedPage {...props} />;
}
