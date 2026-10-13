'use client';

// The folder browser (C-Files-Browser) at /[driveId]/files/browse/[[...path]]:
// the folder the path names, listed from the drive tree the pane shows, with
// the Files strip, the sortable table or tiles, the row menu, the empty and
// drop states, and the dialogs its menu opens.

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import useSWR, { useSWRConfig } from 'swr';
import { useApiClient } from '@/api/swr-provider';
import { ApiError } from '@/api/errors';
import { CopyPageDialog } from '@/retained/components/dialogs/CopyPageDialog';
import { DeletePageDialog } from '@/retained/components/dialogs/DeletePageDialog';
import { MovePageDialog } from '@/retained/components/dialogs/MovePageDialog';
import { RenameDialog } from '@/retained/components/dialogs/RenameDialog';
import { useFavorites as useFavoritesStore } from '@/retained/hooks/useFavorites';
import type { SelectedPageInfo } from '@/retained/stores/useMultiSelectStore';
import { RetainedSurface } from '@/retained-adapters/retained-provider';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { DRIVES, drivesFrom } from '../../frame/drives/drives';
import { PAGE_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { useCreateFile, fileHref } from '../create-file/create-file';
import { FAVORITES, useFavorites } from '../favorites/favorites';
import type { FileNode } from '../file-model/file-node';
import { onlyListed, withPendingCreates } from '../tree-view/tree-view';
import { useFileTree } from '../use-file-tree/use-file-tree';
import { renamePage, trashPage, uploadFiles } from './files-browser-actions';
import { browseHref, resolveFolder, shortDate, typeLabelOf, viewOf, VIEW_STORAGE_KEY, type FilesView } from './files-browser-model';
import { renderFilesBrowser, type BrowserRow, type Crumb, type MenuEntry, type OpenMenu } from './files-browser.render';
import { DEFAULT_SORT, nextSort, sortNodes, type SortKey, type SortState } from './files-browser-sort';

export type FilesBrowserProps = {
  readonly driveId: string;
  /** The folder ids from the top of the drive down, as the route names them; empty is the top. */
  readonly folderIds: readonly string[];
};

type DialogKind = 'rename' | 'move' | 'copy' | 'trash';
type DialogState = { readonly kind: DialogKind; readonly node: FileNode };
type MenuState = { readonly id: string; readonly x: number; readonly y: number };

const selectPending = (state: UiState) => state.resources.pendingFiles;
const selectCreateError = (state: UiState) => state.resources.fileCreateError;

const carriesFiles = (event: DragEvent<HTMLElement>): boolean =>
  Array.from(event.dataTransfer?.types ?? []).includes('Files');

const fileCountOf = (event: DragEvent<HTMLElement>): number =>
  Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file').length;

/** The page a menu action acts on, as the retained move and copy dialogs take it. */
const pageInfoOf = (node: FileNode, driveId: string, parentId: string | null): SelectedPageInfo => ({
  id: node.id,
  title: node.name,
  type: node.pageType,
  driveId,
  parentId,
});

export function FilesBrowser({ driveId, folderIds }: FilesBrowserProps): ReactNode {
  const router = useRouter();
  const client = useApiClient();
  const { mutate } = useSWRConfig();
  const tree = useFileTree(driveId);
  const pending = useUiState(selectPending);
  const createError = useUiState(selectCreateError);
  const favorites = useFavorites(driveId);
  const drivesData = useSWR<unknown>(DRIVES);

  const [view, setView] = useState<FilesView>('list');
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dropCount, setDropCount] = useState(0);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // The chosen view is read after mount (the server has no storage to read) and kept for the next visit.
  useEffect(() => {
    setView(viewOf(window.localStorage.getItem(VIEW_STORAGE_KEY)));
  }, []);
  const chooseView = useCallback((next: FilesView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage is unavailable (private mode, quota): the view still changes for this visit.
    }
  }, []);

  // Close the row menu on a press outside it or on Escape.
  useEffect(() => {
    if (menu === null) return;
    const onPress = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[role="menu"], [data-menu-trigger]') !== null) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('pointerdown', onPress);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPress);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const drawn = useMemo(
    () =>
      tree.nodes === undefined
        ? undefined
        : withPendingCreates(onlyListed(tree.nodes, tree.listedIds), pending, driveId),
    [tree.nodes, tree.listedIds, pending, driveId],
  );
  const nodes = drawn?.nodes ?? [];
  const path = drawn === undefined ? undefined : resolveFolder(drawn.nodes, folderIds);
  const folder = path?.at(-1);
  const driveName = drivesFrom(drivesData.data, null)?.find((entry) => entry.id === driveId)?.name ?? 'Files';

  const create = useCreateFile({
    driveId,
    nodes,
    selectedId: folder?.id ?? null,
    revalidate: tree.retry,
    open: (href) => router.push(href),
  });

  const closeMenu = useCallback(() => setMenu(null), []);
  const openDialog = useCallback((kind: DialogKind, node: FileNode) => {
    setMenu(null);
    setDialog({ kind, node });
  }, []);

  const toggleFavorite = async (node: FileNode, favorited: boolean): Promise<void> => {
    setMenu(null);
    try {
      const store = useFavoritesStore.getState();
      if (favorited) await store.removeFavorite(node.id);
      else await store.addFavorite(node.id);
    } catch {
      toast.error('Error updating favorites.');
    } finally {
      void mutate(FAVORITES);
    }
  };

  const rename = async (node: FileNode, title: string): Promise<void> => {
    try {
      await renamePage(client, node.id, title);
      tree.rename(node.id, title);
      toast.success('Page renamed.');
    } catch {
      toast.error('Error renaming page.');
    } finally {
      setDialog(null);
    }
  };

  const trash = async (node: FileNode, trashChildren: boolean): Promise<void> => {
    try {
      await trashPage(client, node.id, trashChildren);
      tree.retry();
      toast.success('Page moved to trash.');
    } catch {
      toast.error('Error moving page to trash.');
    } finally {
      setDialog(null);
    }
  };

  const upload = async (files: readonly File[]): Promise<void> => {
    setUploadNotice(null);
    try {
      const outcome = await uploadFiles(client, files, { driveId, parentId: folder?.id ?? null });
      if (outcome.uploaded > 0) toast.success(`Successfully uploaded ${outcome.uploaded} of ${files.length} file(s)`);
      if (outcome.failed.length > 0) setUploadNotice(`Could not upload ${outcome.failed.join(', ')}.`);
      tree.retry();
    } catch (failure) {
      setUploadNotice(failure instanceof ApiError ? failure.message : 'Could not upload these files.');
    }
  };

  const onPicked = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    void upload(files);
  };

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropCount(Math.max(fileCountOf(event), 1));
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropCount(0);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropCount(0);
    void upload(Array.from(event.dataTransfer.files));
  };

  if (drawn === undefined) {
    return tree.error === undefined
      ? renderLoadingState('Loading files…')
      : renderErrorState({ title: 'Could not load these files', retry: tree.retry });
  }
  if (path === undefined) {
    return renderNotFound({ ...PAGE_NOT_FOUND, homeHref: browseHref(driveId, []), linkLabel: 'Back to Files' });
  }

  const parentId = folder?.id ?? null;
  const items = sortNodes(folder?.children ?? drawn.nodes, sort);
  const openMenuNode = menu === null ? undefined : items.find((node) => node.id === menu.id);

  const hrefOf = (node: FileNode): string =>
    node.kind === 'folder' ? browseHref(driveId, [...path, node]) : fileHref(driveId, node.id);

  const entriesFor = (node: FileNode, href: string): readonly MenuEntry[] => {
    const favorited = favorites.some((entry) => entry.id === node.id);
    return [
      { kind: 'item', key: 'open', label: 'Open', icon: 'arrowUpRight', href, onSelect: closeMenu },
      { kind: 'item', key: 'open-new-tab', label: 'Open in new tab', href, newTab: true, onSelect: closeMenu },
      { kind: 'separator', key: 'sep-open' },
      { kind: 'item', key: 'rename', label: 'Rename', onSelect: () => openDialog('rename', node) },
      {
        kind: 'item',
        key: 'favorite',
        label: favorited ? 'Unfavorite' : 'Favorite',
        onSelect: () => void toggleFavorite(node, favorited),
      },
      { kind: 'separator', key: 'sep-move' },
      { kind: 'item', key: 'move', label: 'Move to...', onSelect: () => openDialog('move', node) },
      { kind: 'item', key: 'copy', label: 'Copy to...', onSelect: () => openDialog('copy', node) },
      { kind: 'separator', key: 'sep-trash' },
      { kind: 'item', key: 'trash', label: 'Trash', icon: 'trash', danger: true, onSelect: () => openDialog('trash', node) },
    ];
  };

  const rows: readonly BrowserRow[] = items.map((node): BrowserRow => {
    const href = hrefOf(node);
    const menuLabel = `Actions for ${node.name}`;
    return {
      id: node.id,
      title: node.name,
      pageType: node.pageType,
      typeLabel: typeLabelOf(node.pageType),
      updated: node.updatedAt === undefined ? null : shortDate(node.updatedAt),
      href,
      pending: drawn.pendingIds.includes(node.id),
      menuLabel,
      menuOpen: menu?.id === node.id,
      onOpenMenu: (x, y) => setMenu((current) => (current?.id === node.id ? null : { id: node.id, x, y })),
      onContextMenu: (x, y) => setMenu({ id: node.id, x, y }),
    };
  });

  const openMenu: OpenMenu | null =
    menu === null || openMenuNode === undefined
      ? null
      : {
          label: `Actions for ${openMenuNode.name}`,
          x: menu.x,
          y: menu.y,
          entries: entriesFor(openMenuNode, hrefOf(openMenuNode)),
        };

  const crumbs: readonly Crumb[] = [
    { href: browseHref(driveId, []), label: driveName, current: path.length === 0 },
    ...path.map((node, index): Crumb => ({
      href: browseHref(driveId, path.slice(0, index + 1)),
      label: node.name,
      current: index === path.length - 1,
    })),
  ];

  const dialogNode = dialog?.node;
  const dialogPage = dialogNode === undefined ? undefined : pageInfoOf(dialogNode, driveId, parentId);

  return (
    <>
      {renderFilesBrowser({
        crumbs,
        view,
        onView: chooseView,
        sort,
        onSort: (key: SortKey) => setSort((current) => nextSort(current, key)),
        rows,
        folderName: folder?.name ?? driveName,
        empty: items.length === 0,
        dropCount,
        onNewPage: () => void create(),
        onUpload: () => picker.current?.click(),
        onDragEnter,
        onDragOver,
        onDragLeave,
        onDrop,
        picker: (
          <input ref={picker} type="file" multiple hidden data-picker="" onChange={onPicked} aria-label="Upload files" />
        ),
        createError,
        uploadNotice,
        menu: openMenu,
        onCloseMenu: closeMenu,
      })}
      <RetainedSurface>
        <RenameDialog
          isOpen={dialog?.kind === 'rename'}
          onClose={() => setDialog(null)}
          onRename={(title) => {
            if (dialogNode !== undefined) void rename(dialogNode, title);
          }}
          initialName={dialogNode?.name ?? ''}
          title="Rename Page"
          description="Enter a new name for your page."
        />
        <DeletePageDialog
          isOpen={dialog?.kind === 'trash'}
          onClose={() => setDialog(null)}
          onConfirm={(trashChildren) => {
            if (dialogNode !== undefined) void trash(dialogNode, trashChildren);
          }}
          hasChildren={(dialogNode?.children?.length ?? 0) > 0}
        />
        <MovePageDialog
          isOpen={dialog?.kind === 'move'}
          onClose={() => setDialog(null)}
          pages={dialogPage === undefined ? [] : [dialogPage]}
          onSuccess={tree.retry}
        />
        <CopyPageDialog
          isOpen={dialog?.kind === 'copy'}
          onClose={() => setDialog(null)}
          pages={dialogPage === undefined ? [] : [dialogPage]}
          onSuccess={tree.retry}
        />
      </RetainedSurface>
    </>
  );
}
