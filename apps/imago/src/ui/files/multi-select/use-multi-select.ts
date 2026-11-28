'use client';

import { useMultiSelectStore } from '@/retained/stores/useMultiSelectStore';
import type { FileNode } from '../file-model/file-node';
import type { TreeRowSelection } from '../tree-row/tree-row.render';

export type MultiSelection = {
  /** Select multiple is on in this drive. */
  readonly active: boolean;
  readonly selectedIds: ReadonlySet<string>;
  /** The page ids selected, in the order they were picked. */
  readonly pageIds: readonly string[];
  /** The tree's checkboxes, when the mode is on. */
  readonly rowSelection: TreeRowSelection | undefined;
  readonly exit: () => void;
  readonly clear: () => void;
};

/**
 * The tree's multi-select, on the vendored useMultiSelectStore that classic's tree uses. Only the
 * drive it was entered in counts as active.
 */
export function useMultiSelection(driveId: string): MultiSelection {
  const active = useMultiSelectStore((state) => state.isMultiSelectMode && state.activeDriveId === driveId);
  const selected = useMultiSelectStore((state) => state.selectedPages);
  const togglePage = useMultiSelectStore((state) => state.togglePageSelection);
  const exit = useMultiSelectStore((state) => state.exitMultiSelectMode);
  const clear = useMultiSelectStore((state) => state.clearSelection);
  const selectedIds = new Set(selected.keys());
  const rowSelection: TreeRowSelection | undefined = active
    ? {
        selectedIds,
        toggle: (node: FileNode) =>
          togglePage({ id: node.id, title: node.name, type: node.pageType, driveId, parentId: null }),
      }
    : undefined;
  return { active, selectedIds, pageIds: [...selected.keys()], rowSelection, exit, clear };
}
