'use client';

import dynamic from 'next/dynamic';
import type { PageTypeProps } from './shared';

const CanvasPageView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/canvas/CanvasPageView'), { ssr: false });

/** A canvas in the v3 middle (C-Files-Canvas): classic's canvas view; its strip lands in IMC-3.5. */
export function CanvasPage({ pageId }: PageTypeProps) {
  return <CanvasPageView pageId={pageId} />;
}
