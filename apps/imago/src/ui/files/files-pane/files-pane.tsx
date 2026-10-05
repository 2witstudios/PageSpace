'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo } from 'react';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { dispatch, transactions } from '../../store/transactions';
import { ListPane } from '../../frame/list-pane/list-pane';
import type { ListPane as ListPaneVariant } from '../../frame/stage/stage';
import { fileHref, useCreateFile } from '../create-file/create-file';
import { renderTreeRows } from '../tree-row/tree-row.render';
import {
  disclosableIds,
  filterTree,
  onlyListed,
  settledKeys,
  withPendingCreates,
  type PendingTree,
} from '../tree-view/tree-view';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { useFileTree } from '../use-file-tree/use-file-tree';
import { renderFilesPane, renderNewPageButton } from './files-pane.render';

export type FilesPaneProps = {
  readonly driveId: string;
  /** The page open as the object, if any. */
  readonly selectedPageId: string | null;
  readonly variant: Exclude<ListPaneVariant, 'closed'>;
  readonly title: string;
  readonly closeHref: string;
};

const selectFilter = (state: UiState) => state.resources.fileFilter;
const selectPending = (state: UiState) => state.resources.pendingFiles;
const selectCreateError = (state: UiState) => state.resources.fileCreateError;

const typeFilter = (filter: string) => dispatch(transactions.setFileFilter, filter);

const NO_TREE: PendingTree = { nodes: [], pendingIds: [] };

/**
 * The Files section's list pane: the drive's page tree, live, filtered by
 * what the viewer types, with + in the header to create a document in the
 * selected folder. Only pages the drive tree lists are drawn, plus the
 * viewer's own creates until the tree lists them. While the tree loads, if
 * it fails and when the drive has no pages, the designed state shows.
 */
export function FilesPane({ driveId, selectedPageId, variant, title, closeHref }: FilesPaneProps) {
  const router = useRouter();
  const tree = useFileTree(driveId);
  const filter = useUiState(selectFilter);
  const pending = useUiState(selectPending);
  const createError = useUiState(selectCreateError);
  const { nodes, listedIds } = tree;

  const drawn = useMemo(
    () => (nodes === undefined ? undefined : withPendingCreates(onlyListed(nodes, listedIds), pending, driveId)),
    [nodes, listedIds, pending, driveId],
  );

  // A create the drive tree now lists is drawn by the tree alone.
  useEffect(() => {
    for (const key of settledKeys(pending, listedIds, driveId)) dispatch(transactions.fileCreateSettled, key);
  }, [pending, listedIds, driveId]);

  const open = useCallback((href: string) => router.push(href), [router]);
  const create = useCreateFile({
    driveId,
    nodes: (drawn ?? NO_TREE).nodes,
    selectedId: selectedPageId,
    revalidate: tree.retry,
    open,
  });
  const hrefFor = useCallback((pageId: string) => fileHref(driveId, pageId), [driveId]);

  // + is off until the tree loads, and while this drive's create is unanswered.
  const creating = pending.some((file) => file.driveId === driveId && file.pageId === null);
  const actions = renderNewPageButton({ create: () => void create(), disabled: drawn === undefined || creating });
  const body = (() => {
    if (drawn === undefined) {
      return tree.error === undefined
        ? renderLoadingState('Loading pages…')
        : renderErrorState({ title: 'Could not load pages', retry: tree.retry });
    }
    const shown = filterTree(drawn.nodes, filter);
    const filtering = filter.trim() !== '';
    return renderFilesPane({
      filter,
      typeFilter,
      createError,
      empty: drawn.nodes.length === 0,
      noMatch: drawn.nodes.length > 0 && shown.length === 0,
      rows: renderTreeRows({
        nodes: shown,
        selectedId: selectedPageId,
        // A filtered tree opens every page on the way to a match.
        expandedIds: filtering ? disclosableIds(shown) : tree.expandedIds,
        pendingIds: drawn.pendingIds,
        hrefFor,
        toggle: tree.toggle,
      }),
    });
  })();

  return (
    <ListPane section="files" variant={variant} title={title} closeHref={closeHref} actions={actions}>
      {body}
    </ListPane>
  );
}
