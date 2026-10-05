import type { ReactNode } from 'react';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { getViewer } from '@/lib/auth/get-viewer';
import { renderAccount } from '@/ui/settings/account/account.render';
import { accountLinks } from '@/ui/settings/settings-model/settings-model';

/**
 * The account: an object beside the chat, with no list, linking into
 * classic's settings. Billing shows where classic shows it. The route
 * renders only the object slot's content.
 */
export default async function Page(): Promise<ReactNode> {
  await getViewer();
  return renderAccount({ links: accountLinks({ billing: isBillingEnabled() }) });
}
