'use client';

import dynamic from 'next/dynamic';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import PublishControls from '@/retained/components/layout/middle-content/content-header/PublishControls';
import { useDocumentManagerStore } from '@/retained/stores/useDocumentManagerStore';
import {
  CANVAS_TABS,
  useCanvasTab,
  type CanvasTab,
} from '@/retained/components/layout/middle-content/page-views/canvas/useCanvasTab';
import type { PageTypeProps } from './shared';

const CanvasPageView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/canvas/CanvasPageView'), { ssr: false });

const TAB_LABELS: Record<CanvasTab, string> = { view: 'View', code: 'Code', settings: 'Settings' };

/** View / Code / Settings as the canvas's tablist; the tab itself is the `?tab=` search param. */
function CanvasTabs({ pageId }: { readonly pageId: string }) {
  const { activeTab, setActiveTab, isReadOnly } = useCanvasTab(pageId);
  return (
    <div role="tablist" aria-label="Canvas" className="flex h-full items-center gap-1">
      {CANVAS_TABS.map((tab) => {
        const selected = activeTab === tab;
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={tab === 'settings' && isReadOnly}
            onClick={() => setActiveTab(tab)}
            className={`rounded-md px-2 py-1 text-sm ${selected ? 'bg-fill font-medium text-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            {TAB_LABELS[tab]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A canvas in the v3 middle (C-Files-Canvas): the Page tools strip with the View/Code/Settings
 * tablist and the publish status and update action, then classic's canvas view for the tab.
 */
export function CanvasPage({ pageId }: PageTypeProps) {
  const isDirty = useDocumentManagerStore((state) => state.documents.get(pageId)?.isDirty ?? false);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ToolbarStrip label="Page tools">
        <CanvasTabs pageId={pageId} />
        <div className="flex-1" />
        <PublishControls pageId={pageId} contentDirty={isDirty} variant="strip" />
      </ToolbarStrip>
      <div className="flex min-h-0 flex-1 flex-col">
        <CanvasPageView pageId={pageId} />
      </div>
    </div>
  );
}
