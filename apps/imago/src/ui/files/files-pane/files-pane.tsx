'use client';

import type { ReactNode } from 'react';
import { renderEmptyState, renderErrorState, renderLoadingState } from '../../frame/edge-state/edge-state.render';
import { useFileTree } from '../use-file-tree/use-file-tree';

export type FilesPaneProps = {
  readonly driveId: string;
  /** The drive's tree rows, drawn once it has pages; the tree pane (IMG-7.2) supplies them. */
  readonly rows?: ReactNode;
};

/**
 * The Files section's list pane: while the drive's tree loads, if it fails
 * and when the drive has no pages, the designed state; otherwise its rows.
 */
export function FilesPane({ driveId, rows = null }: FilesPaneProps) {
  const { nodes, error, retry } = useFileTree(driveId);
  if (nodes === undefined) {
    return error === undefined
      ? renderLoadingState('Loading pages…')
      : renderErrorState({ title: 'Could not load pages', retry });
  }
  if (nodes.length === 0) return renderEmptyState({ title: 'No pages yet', detail: 'Pages in this drive show up here.' });
  return rows;
}
