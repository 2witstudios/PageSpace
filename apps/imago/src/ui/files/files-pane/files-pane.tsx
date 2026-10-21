'use client';

import { useImagoPageId } from '../../chat/use-chat-data/use-chat-data';
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
import { DriveList } from '../../frame/drives/drive-list';
import { ScopeSwitch } from '../../frame/drives/scope-switch';
import { useDriveNames } from '../../frame/drives/use-drive-names';
import { useAllDrives } from '../../frame/drives/use-section-scope';
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
 * label. Switched to All drives, Favorites and Recents are every drive's, each naming its drive,
 * and Pages gives way to the drives to pick from.
 */
export function FilesPane({ driveId, selectedPageId, variant, title, phoneHeader }: FilesPaneProps) {
  const phone = phoneHeader !== undefined;
  const [filter, setFilter] = useState('');
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  useEffect(() => {
    void fetchDrives();
  }, [fetchDrives]);
  const allDrives = useAllDrives('files', driveId);
  const driveNames = useDriveNames(allDrives);
  const favorites = useFavorites(allDrives ? null : driveId);
  const recents = useRecents(driveId, 3, allDrives);
  const driveName = (id: string): string | undefined => driveNames?.get(id);
  const imagoPageId = useImagoPageId();
  const now = new Date();
  const canCreate = drives.find((drive) => drive.id === driveId)?.canCreatePages === true;
  const actions = renderNewPageButton({ create: (anchor) => useUIStore.getState().openQuickCreate(null, anchor), disabled: !canCreate });
  const scope = <ScopeSwitch section="files" driveId={driveId} />;
  const body = (
    <>
      <label className={filterClass}>
        {renderIcon({ name: 'filter', size: 14 })}
        <input
          aria-label={allDrives ? 'Filter drives' : 'Filter pages'}
          placeholder={allDrives ? 'Filter drives' : 'Filter pages'}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none"
        />
      </label>
      {favorites.length === 0 ? null : (
        <PaneGroup label="Favorites">
          {favorites.map((page) => (
            <PaneRow key={page.id} href={drivePageHref(page.driveId, page.id)} title={page.title} type={page.type} current={page.id === selectedPageId} imago={page.id === imagoPageId} meta={driveName(page.driveId)} roomy={phone} />
          ))}
        </PaneGroup>
      )}
      {recents.length === 0 ? null : (
        <PaneGroup label="Recents">
          {recents.map((page) => (
            <PaneRow
              key={page.id}
              href={drivePageHref(page.driveId, page.id)}
              title={page.title}
              type={page.type}
              current={false}
              imago={page.id === imagoPageId}
              meta={[driveName(page.driveId), ageLabel(page.viewedAt, now)].filter(Boolean).join(' · ')}
              roomy={phone}
            />
          ))}
        </PaneGroup>
      )}
      {allDrives ? (
        <PaneGroup label="Drives">
          <DriveList section="files" currentId={driveId} filter={filter} />
        </PaneGroup>
      ) : (
        <PaneGroup label="Pages">
          <RetainedSurface fill={false}>
            <PageTree driveId={driveId} searchQuery={filter} roomyRows={phone} />
          </RetainedSurface>
        </PaneGroup>
      )}
    </>
  );
  if (phoneHeader !== undefined) {
    return (
      <section aria-label={title} className="flex h-full min-h-0 w-full flex-col">
        {phoneHeader(
          <>
            {scope}
            {actions}
          </>,
        )}
        <div className={listBodyClass}>{body}</div>
      </section>
    );
  }
  return (
    <ListPane section="files" variant={variant} title={title} actions={actions} scope={scope}>
      {body}
    </ListPane>
  );
}
