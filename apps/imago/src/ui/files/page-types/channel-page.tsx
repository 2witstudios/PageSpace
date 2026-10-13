'use client';

import dynamic from 'next/dynamic';
import type { PageTypeProps } from './shared';

const ChannelView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/channel/ChannelView'), { ssr: false });

/** A channel in the v3 middle (C-Files-Channel): classic's channel view; its strip lands in IMC-3.9. */
export function ChannelPage({ page }: PageTypeProps) {
  return <ChannelView page={page} />;
}
