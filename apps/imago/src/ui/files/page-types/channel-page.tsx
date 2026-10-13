'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { PageWebhooksDialog, useCanManagePageWebhooks } from '@/retained/components/shared/PageWebhooksDialog';
import { IconButton } from '@/ui/components/icon-button/icon-button';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import type { PageTypeProps } from './shared';

const ChannelView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/channel/ChannelView'), { ssr: false });

/**
 * A channel in the v3 middle (C-Files-Channel): the Channel tools strip, then classic's posts and
 * composer. The audience line and "Threads · n" wait on their APIs (needs-api) and are not drawn.
 */
export function ChannelPage({ page }: PageTypeProps) {
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  // Webhooks are for the drive owner and admins: the button is absent for anyone the route refuses (IMC-4.4).
  const canManageWebhooks = useCanManagePageWebhooks(page.id);
  // The Messages board names the strip "Channel"; the Files board names it "Channel tools".
  const pathname = usePathname() ?? '';
  const stripLabel = pathname.includes('/messages/') ? 'Channel' : 'Channel tools';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label={stripLabel}>
        <div className="flex-1" />
        {canManageWebhooks ? <IconButton name="webhook" label="Webhooks" onClick={() => setWebhooksOpen(true)} /> : null}
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <ChannelView page={page} floatingWebhooks={false} />
      </div>
      <PageWebhooksDialog open={webhooksOpen} onOpenChange={setWebhooksOpen} pageId={page.id} pageType="CHANNEL" />
    </div>
  );
}
