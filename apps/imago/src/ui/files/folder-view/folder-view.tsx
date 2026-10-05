'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useUiState } from '../../store/store';
import type { UiState } from '../../store/state';
import { renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { PAGE_NOT_FOUND, renderNotFound } from '../../frame/not-found/not-found.render';
import { todayOf } from '../../time/time';
import { fileHref, isCreatingIn, useCreateFile } from '../create-file/create-file';
import { onlyListed, pathTo, withPendingCreates } from '../tree-view/tree-view';
import { useFileTree } from '../use-file-tree/use-file-tree';
import { renderFolderView } from './folder-view.render';

export type FolderViewProps = {
  readonly driveId: string;
  readonly folderId: string;
  /** The clock the Modified column reads; injected for tests. */
  readonly now?: () => Date;
};

const selectPending = (state: UiState) => state.resources.pendingFiles;
const selectCreateError = (state: UiState) => state.resources.fileCreateError;

const systemNow = (): Date => new Date();

/**
 * A FOLDER page at /imago/[driveId]/files/[pageId], in the object slot: its
 * children and the path down to it, read from the drive's tree, the one the
 * tree pane shows, so the browser lists exactly what the drive tree lists
 * and never asks the children route (which checks only the parent). It is
 * live with the tree; New page in an empty folder is the tree pane's create,
 * aimed at this folder.
 */
export function FolderView({ driveId, folderId, now = systemNow }: FolderViewProps): ReactNode {
  const router = useRouter();
  const tree = useFileTree(driveId);
  const pending = useUiState(selectPending);
  const createError = useUiState(selectCreateError);
  const { nodes, listedIds } = tree;

  const drawn = useMemo(
    () => (nodes === undefined ? undefined : withPendingCreates(onlyListed(nodes, listedIds), pending, driveId)),
    [nodes, listedIds, pending, driveId],
  );

  const open = useCallback((href: string) => router.push(href), [router]);
  const create = useCreateFile({
    driveId,
    nodes: drawn?.nodes ?? [],
    selectedId: folderId,
    revalidate: tree.retry,
    open,
  });
  const hrefFor = useCallback((pageId: string) => fileHref(driveId, pageId), [driveId]);
  const filesHref = `/${encodeURIComponent(driveId)}/files`;

  if (drawn === undefined) {
    return tree.error === undefined
      ? renderLoadingState('Loading folder…')
      : renderErrorState({ title: 'Could not load this folder', retry: tree.retry });
  }
  // The drive tree is the authority on what the viewer sees: a folder it
  // does not list draws as any unknown page does.
  const path = pathTo(drawn.nodes, folderId);
  if (path === undefined) {
    return renderNotFound({ ...PAGE_NOT_FOUND, homeHref: filesHref, linkLabel: 'Back to Files' });
  }
  return renderFolderView({
    path,
    filesHref,
    hrefFor,
    pendingIds: drawn.pendingIds,
    today: todayOf(now()),
    create: () => void create(),
    creating: isCreatingIn(pending, driveId),
    createError,
  });
}
