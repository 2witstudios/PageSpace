'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { PageWebhooksDialog } from '@/retained/components/shared/PageWebhooksDialog';
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
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Channel tools">
        <div className="flex-1" />
        {/* Deliberately not permission-gated: the dialog explains the owner/admin requirement. */}
        <IconButton name="webhook" label="Webhooks" onClick={() => setWebhooksOpen(true)} />
      </ToolbarStrip>
      <div className="min-h-0 flex-1">
        <ChannelView page={page} floatingWebhooks={false} />
      </div>
      <PageWebhooksDialog open={webhooksOpen} onOpenChange={setWebhooksOpen} pageId={page.id} pageType="CHANNEL" />
    </div>
  );
}
