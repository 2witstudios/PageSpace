'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ListPane } from '../../frame/list-pane/list-pane';
import type { ListPane as ListPaneVariant } from '../../frame/stage/stage';
import { listBodyClass } from '../../frame/list-pane/list-pane-class';
import { renderIcon } from '../../components/icon/icon.render';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import PageTree from '@/retained/components/layout/left-sidebar/page-tree/PageTree';
import { useUIStore } from '@/retained/stores/useUIStore';
import { useDriveStore } from '@/retained/hooks/useDrive';
import { useFavorites } from '../favorites/favorites';
import { ageLabel, drivePageHref, useRecents } from '../recents/recents';
import { PaneGroup, PaneRow } from './pane-groups';
import { renderNewPageButton } from './files-pane.render';

export type FilesPaneProps = {
  readonly driveId: string;
  readonly selectedPageId: string | null;
  readonly variant: Exclude<ListPaneVariant, 'closed'>;
  readonly title: string;
  /**
   * The phone's full-screen pane (C-Resp-Phone-Tree): the given head replaces the pane head
   * (the New page button is handed to it), rows are 44px and there is no Close sidebar.
   */
  readonly phoneHeader?: (newPage: ReactNode) => ReactNode;
};

/** The 32px filter field at the top of the pane (SPEC v3: radius 8, fill). */
const filterClass = 'mx-px mb-2 flex h-filter flex-none items-center gap-2 rounded-md bg-fill px-3 text-ink-faint';

/**
 * The Files pane (IMC-1.8, SPEC v3 "Pane (Files tree pane)"): head "Files" with New page and
 * Close sidebar; "Filter pages"; then Favorites (this drive's favorite pages), Recents (with
 * their ages) and Pages, classic's page tree reused as it is, each group folding under its
 * label.
 */
export function FilesPane({ driveId, selectedPageId, variant, title, phoneHeader }: FilesPaneProps) {
  const phone = phoneHeader !== undefined;
  const [filter, setFilter] = useState('');
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  useEffect(() => {
    void fetchDrives();
  }, [fetchDrives]);
  const favorites = useFavorites(driveId);
  const recents = useRecents(driveId, 3);
  const now = new Date();
  const canCreate = drives.find((drive) => drive.id === driveId)?.canCreatePages === true;
  const actions = renderNewPageButton({ create: (anchor) => useUIStore.getState().openQuickCreate(null, anchor), disabled: !canCreate });
  const body = (
    <>
      <label className={filterClass}>
        {renderIcon({ name: 'filter', size: 14 })}
        <input
          aria-label="Filter pages"
          placeholder="Filter pages"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
        />
      </label>
      {favorites.length === 0 ? null : (
        <PaneGroup label="Favorites">
          {favorites.map((page) => (
            <PaneRow key={page.id} href={drivePageHref(driveId, page.id)} title={page.title} type={page.type} current={page.id === selectedPageId} roomy={phone} />
          ))}
        </PaneGroup>
      )}
      {recents.length === 0 ? null : (
        <PaneGroup label="Recents">
          {recents.map((page) => (
            <PaneRow
              key={page.id}
              href={drivePageHref(driveId, page.id)}
              title={page.title}
              type={page.type}
              current={false}
              meta={ageLabel(page.viewedAt, now)}
              roomy={phone}
            />
          ))}
        </PaneGroup>
      )}
      <PaneGroup label="Pages">
        <RetainedSurface fill={false}>
          <PageTree driveId={driveId} searchQuery={filter} roomyRows={phone} />
        </RetainedSurface>
      </PaneGroup>
    </>
  );
  if (phoneHeader !== undefined) {
    return (
      <section aria-label={title} className="flex h-full min-h-0 w-full flex-col">
        {phoneHeader(actions)}
        <div className={listBodyClass}>{body}</div>
      </section>
    );
  }
  return (
    <ListPane section="files" variant={variant} title={title} actions={actions}>
      {body}
    </ListPane>
  );
}
