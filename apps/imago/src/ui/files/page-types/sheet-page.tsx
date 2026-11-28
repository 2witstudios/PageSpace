'use client';

import dynamic from 'next/dynamic';
import { ToolbarStrip } from '@/ui/frame/toolbar-strip/toolbar-strip';
import { renderIconButton } from '@/ui/components/icon-button/icon-button.render';
import { Popover, PopoverContent, PopoverTrigger } from '@/retained/components/ui/popover';
import type { SheetToolsControls } from '@/retained/components/layout/middle-content/page-views/sheet/SheetView';
import { SaveStatus, type PageTypeProps } from './shared';

const SheetView = dynamic(() => import('@/retained/components/layout/middle-content/page-views/sheet/SheetView'), { ssr: false });

/**
 * The sheet's Page tools strip (C-Files-Sheet): size, Undo, Redo and save status. The
 * formatting tools sit behind More, so nothing classic offered is lost.
 */
export function SheetPageTools({ controls, pageId }: { readonly controls: SheetToolsControls; readonly pageId: string }) {
  return (
    <ToolbarStrip label="Page tools">
      <span className="text-xs text-ink-muted">{`${controls.rowCount} rows · ${controls.columnCount} columns`}</span>
      <div className="flex-1" />
      {renderIconButton({ name: 'undo', label: 'Undo', disabled: !controls.canUndo, onClick: controls.onUndo })}
      {renderIconButton({ name: 'redo', label: 'Redo', disabled: !controls.canRedo, onClick: controls.onRedo })}
      <SaveStatus pageId={pageId} />
      <Popover>
        <PopoverTrigger asChild>{renderIconButton({ name: 'more', label: 'More' })}</PopoverTrigger>
        <PopoverContent align="end">{controls.toolbar}</PopoverContent>
      </Popover>
    </ToolbarStrip>
  );
}

/** A sheet in the v3 middle (C-Files-Sheet): its Page tools strip, then classic's formula bar and grid. */
export function SheetPage({ page }: PageTypeProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetView page={page} renderTools={(controls) => <SheetPageTools controls={controls} pageId={page.id} />} />
    </div>
  );
}
