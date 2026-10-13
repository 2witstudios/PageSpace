'use client';

// The drives screen (C-Account-Drives): every drive the viewer can open, grouped as Favorites, Personal and
// drives shared with them, as a sortable table or a grid, with a per-drive actions menu. Drive data comes from
// apps/web (GET /api/drives and GET /api/user/favorites) through the drive and favorites stores. The
// organization grouping and drive visibility are not on this branch and are left out.

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from '@/retained-adapters/navigation';
import { toast } from 'sonner';
import { useDriveStore, type Drive } from '@/retained/hooks/useDrive';
import { useFavorites, useFavoritesSync } from '@/retained/hooks/useFavorites';
import { patch, del } from '@/retained/lib/auth/auth-fetch';
import { driveFocus, focusSectionHref } from '@/retained/lib/dashboard/focus';
import CreateDriveDialog from '@/retained/components/layout/left-sidebar/CreateDriveDialog';
import { RenameDialog } from '@/retained/components/dialogs/RenameDialog';
import { DeleteDriveDialog } from '@/retained/components/dialogs/DeleteDriveDialog';
import { Icon } from '../../components/icon/icon';
import { SettingsScreen, SettingsSection } from '../settings-screen/settings-screen';
import {
  DEFAULT_SORT,
  createdLabel,
  driveActionsOf,
  groupDrives,
  lastAccessedLabel,
  nextSort,
  roleLabel,
  type DriveAction,
  type DriveGroup,
  type DriveSort,
  type DriveSortKey,
} from './account-drives-model';

export type AccountDrivesViewProps = {
  readonly groups: readonly DriveGroup[];
  readonly layout: 'list' | 'grid';
  readonly sort: DriveSort;
  readonly favoriteIds: ReadonlySet<string>;
  readonly openMenuId: string | null;
  readonly onLayout: (layout: 'list' | 'grid') => void;
  readonly onSort: (key: DriveSortKey) => void;
  readonly onNewDrive: () => void;
  readonly onToggleMenu: (driveId: string) => void;
  readonly onAction: (drive: Drive, action: DriveAction) => void;
  readonly onOpen: (drive: Drive) => void;
};

const SORTABLE: readonly { readonly key: DriveSortKey; readonly label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role' },
  { key: 'lastAccessedAt', label: 'Last accessed' },
  { key: 'createdAt', label: 'Created' },
];

const segmentClass = (active: boolean): string =>
  `inline-flex h-8 items-center rounded-lg px-3 text-sm ${active ? 'bg-accent-soft text-accent-deep' : 'text-ink hover:bg-tint'}`;

function DriveMenu({ drive, isFavorite, open, onToggle, onAction }: {
  readonly drive: Drive;
  readonly isFavorite: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onAction: (action: DriveAction) => void;
}) {
  return (
    <div className="relative inline-flex">
      <button
        type="button"
        aria-label="Drive actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={onToggle}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-tint"
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div role="menu" aria-label={`${drive.name} actions`} className="absolute right-0 top-8 z-10 flex flex-col whitespace-nowrap rounded-xl border border-hairline bg-fill p-1 shadow-1">
          {driveActionsOf(drive, isFavorite).map((item) => (
            <button
              key={item.action}
              type="button"
              role="menuitem"
              onClick={() => onAction(item.action)}
              className={`flex h-8 items-center rounded-lg px-2 text-left text-sm hover:bg-tint ${item.action === 'trash' ? 'text-status-danger' : 'text-ink'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The drives page's markup, given its groups and handlers: no requests, so it renders the same in every test. */
export function AccountDrivesView({
  groups,
  layout,
  sort,
  favoriteIds,
  openMenuId,
  onLayout,
  onSort,
  onNewDrive,
  onToggleMenu,
  onAction,
  onOpen,
}: AccountDrivesViewProps) {
  return (
    <SettingsScreen
      title="Drives"
      lede="Every drive you can open, grouped by who owns it. Opening one lands in its Files."
      actions={
        <>
          <div role="group" aria-label="View" className="flex items-center gap-1 rounded-xl border border-hairline p-px">
            <button type="button" aria-pressed={layout === 'list'} onClick={() => onLayout('list')} className={segmentClass(layout === 'list')}>
              List
            </button>
            <button type="button" aria-pressed={layout === 'grid'} onClick={() => onLayout('grid')} className={segmentClass(layout === 'grid')}>
              Grid
            </button>
          </div>
          <button type="button" onClick={onNewDrive} className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-sm text-fill">
            <Icon name="plus" />
            New drive
          </button>
        </>
      }
    >
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">No drives yet. Create one to start organizing your content.</p>
      ) : layout === 'list' ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-ink-muted">
                {SORTABLE.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                    className="px-3 py-2 font-medium"
                  >
                    <button type="button" onClick={() => onSort(column.key)} className="inline-flex items-center gap-1 hover:text-ink">
                      {column.label}
                      {sort.key === column.key ? (
                        <span aria-hidden="true" className={sort.direction === 'desc' ? 'rotate-180' : ''}>
                          <Icon name="chevronDown" size={12} />
                        </span>
                      ) : null}
                    </button>
                  </th>
                ))}
                <th scope="col" className="px-3 py-2 font-medium">
                  <span>Actions</span>
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.label}>
                <tr>
                  <th colSpan={5} scope="colgroup" className="px-3 pb-1 pt-5 text-left text-xs font-medium uppercase tracking-wide text-ink-faint">
                    {group.label} <span className="tabular-nums">{group.drives.length}</span>
                  </th>
                </tr>
                {group.drives.map((drive) => (
                  <tr key={drive.id} className="border-b border-hairline hover:bg-tint">
                    <td className="px-3 py-2">
                      <button type="button" onClick={() => onOpen(drive)} className="inline-flex items-center gap-2 text-left text-ink">
                        <span className="font-medium">{drive.name}</span>
                        {drive.kind === 'HOME' ? <span className="rounded-md bg-fill px-2 text-xs text-ink-muted">Home</span> : null}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-ink-muted">{roleLabel(drive.role)}</td>
                    <td className="px-3 py-2 tabular-nums text-ink-muted">{lastAccessedLabel(drive)}</td>
                    <td className="px-3 py-2 tabular-nums text-ink-muted">{createdLabel(drive)}</td>
                    <td className="px-3 py-2">
                      <DriveMenu
                        drive={drive}
                        isFavorite={favoriteIds.has(drive.id)}
                        open={openMenuId === drive.id}
                        onToggle={() => onToggleMenu(drive.id)}
                        onAction={(action) => onAction(drive, action)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      ) : (
        groups.map((group) => (
          <SettingsSection key={group.label} title={group.label}>
            <div className="grid grid-cols-2 gap-2">
              {group.drives.map((drive) => (
                <button
                  key={drive.id}
                  type="button"
                  onClick={() => onOpen(drive)}
                  className="flex flex-col gap-1 rounded-xl border border-hairline p-3 text-left hover:bg-tint"
                >
                  <span className="truncate text-sm font-medium text-ink">{drive.name}</span>
                  <span className="text-xs text-ink-muted">{drive.kind === 'HOME' ? 'Home' : roleLabel(drive.role)}</span>
                </button>
              ))}
            </div>
          </SettingsSection>
        ))
      )}
    </SettingsScreen>
  );
}

/** The drives screen with its stores: the list, favorites, the row actions and the dialogs they open. */
export function AccountDrives() {
  const router = useRouter();
  const drives = useDriveStore((state) => state.drives);
  const fetchDrives = useDriveStore((state) => state.fetchDrives);
  const updateDrive = useDriveStore((state) => state.updateDrive);
  const removeDrive = useDriveStore((state) => state.removeDrive);
  const { isFavorite, addFavorite, removeFavorite, driveIds: favoriteIds } = useFavorites();
  useFavoritesSync();

  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [sort, setSort] = useState<DriveSort>(DEFAULT_SORT);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<Drive | null>(null);
  const [trashing, setTrashing] = useState<Drive | null>(null);
  const [isTrashing, setIsTrashing] = useState(false);

  useEffect(() => {
    void fetchDrives(false, true);
  }, [fetchDrives]);

  const groups = useMemo(() => groupDrives(drives, favoriteIds, sort), [drives, favoriteIds, sort]);

  const open = (drive: Drive) => {
    setOpenMenuId(null);
    router.push(focusSectionHref(driveFocus(drive.id), 'files'));
  };

  const rename = async (name: string) => {
    if (renaming === null) return;
    const drive = renaming;
    const toastId = toast.loading('Renaming drive...');
    try {
      await patch(`/api/drives/${drive.id}`, { name });
      updateDrive(drive.id, { name });
      toast.success('Drive renamed.', { id: toastId });
    } catch {
      toast.error('Error renaming drive.', { id: toastId });
    } finally {
      setRenaming(null);
    }
  };

  const toggleFavorite = async (drive: Drive) => {
    const was = isFavorite(drive.id, 'drive');
    const toastId = toast.loading(was ? 'Removing from favorites...' : 'Adding to favorites...');
    try {
      await (was ? removeFavorite : addFavorite)(drive.id, 'drive');
      toast.success(`Drive ${was ? 'removed from' : 'added to'} favorites.`, { id: toastId });
    } catch {
      toast.error('Error updating favorites.', { id: toastId });
    }
  };

  const trash = async () => {
    if (trashing === null) return;
    const drive = trashing;
    setIsTrashing(true);
    const toastId = toast.loading('Moving drive to trash...');
    try {
      await del(`/api/drives/${drive.id}`);
      removeDrive(drive.id);
      toast.success('Drive moved to trash.', { id: toastId });
    } catch {
      toast.error('Error moving drive to trash.', { id: toastId });
    } finally {
      setIsTrashing(false);
      setTrashing(null);
    }
  };

  const onAction = (drive: Drive, action: DriveAction) => {
    setOpenMenuId(null);
    if (action === 'open') open(drive);
    if (action === 'rename') setRenaming(drive);
    if (action === 'favorite') void toggleFavorite(drive);
    if (action === 'trash') setTrashing(drive);
  };

  return (
    <>
      <AccountDrivesView
        groups={groups}
        layout={layout}
        sort={sort}
        favoriteIds={favoriteIds}
        openMenuId={openMenuId}
        onLayout={setLayout}
        onSort={(key) => setSort((current) => nextSort(current, key))}
        onNewDrive={() => setCreateOpen(true)}
        onToggleMenu={(driveId) => setOpenMenuId((current) => (current === driveId ? null : driveId))}
        onAction={onAction}
        onOpen={open}
      />
      <CreateDriveDialog isOpen={createOpen} setIsOpen={setCreateOpen} />
      <RenameDialog
        isOpen={renaming !== null}
        onClose={() => setRenaming(null)}
        onRename={rename}
        initialName={renaming?.name ?? ''}
        title="Rename Drive"
        description="Enter a new name for your drive."
      />
      <DeleteDriveDialog
        isOpen={trashing !== null}
        onClose={() => setTrashing(null)}
        onConfirm={trash}
        driveName={trashing?.name ?? ''}
        isDeleting={isTrashing}
      />
    </>
  );
}
