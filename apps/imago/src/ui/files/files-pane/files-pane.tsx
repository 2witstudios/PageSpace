'use client';

import { useEffect, useState } from 'react';
import { ListPane } from '../../frame/list-pane/list-pane';
import type { ListPane as ListPaneVariant } from '../../frame/stage/stage';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import PageTree from '@/retained/components/layout/left-sidebar/page-tree/PageTree';
import { useUIStore } from '@/retained/stores/useUIStore';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { Input } from '@/retained/components/ui/input';
import { renderNewPageButton } from './files-pane.render';

export type FilesPaneProps = {
  readonly driveId: string;
  readonly selectedPageId: string | null;
  readonly variant: Exclude<ListPaneVariant, 'closed'>;
  readonly title: string;
  readonly closeHref: string;
};

export function FilesPane({ driveId, variant, title, closeHref }: FilesPaneProps) {
  const [filter, setFilter] = useState('');
  const drives = useDriveStore(state => state.drives);
  const fetchDrives = useDriveStore(state => state.fetchDrives);
  useEffect(() => { void fetchDrives(); }, [fetchDrives]);
  const canCreate = drives.find(drive => drive.id === driveId)?.canCreatePages === true;
  const actions = renderNewPageButton({ create: () => useUIStore.getState().openQuickCreate(null), disabled: !canCreate });
  return <ListPane section="files" variant={variant} title={title} closeHref={closeHref} actions={actions}>
    <RetainedSurface><div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Input aria-label="Filter files" placeholder="Search pages…" value={filter} onChange={event => setFilter(event.target.value)} />
      <PageTree driveId={driveId} searchQuery={filter} />
    </div></RetainedSurface>
  </ListPane>;
}
