import type { UiSlice, UiState } from '../../store/state';

/**
 * Which pages of the files tree the viewer expanded. It lives in the shell
 * store, apart from the tree data, so revalidating the tree from the server
 * never collapses anything. Page ids are unique across drives.
 */
export const filesPlugin = {
  resources: (): {
    /** Pages expanded in the files tree. */
    readonly expandedFileIds: readonly string[];
  } => ({ expandedFileIds: [] }),
  transactions: {
    toggleFileFolder: (state: UiState, pageId: string): UiState => {
      const open = state.resources.expandedFileIds;
      return {
        ...state,
        resources: {
          ...state.resources,
          expandedFileIds: open.includes(pageId) ? open.filter((id) => id !== pageId) : [...open, pageId],
        },
      };
    },
  },
} satisfies UiSlice;
