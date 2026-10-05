import type { UiSlice, UiState } from '../../store/state';

/**
 * A page the viewer asked for from the tree's + and the server has not yet
 * listed in the drive's tree. `pageId` is null until the create answers.
 */
export type PendingFile = {
  /** The row's id until the server names the page. */
  readonly key: string;
  readonly driveId: string;
  /** Where it is created: a page id, or null for the top of the drive. */
  readonly parentId: string | null;
  readonly title: string;
  /** The server's id once the create answers. */
  readonly pageId: string | null;
  /**
   * The ids already under the parent when the create began, so the page the
   * server makes can be told apart from them if the tree lists it before the
   * create answers.
   */
  readonly knownIds: readonly string[];
};

type FilesResources = {
  /** Pages expanded in the files tree. */
  readonly expandedFileIds: readonly string[];
  /** What the tree pane's filter holds. */
  readonly fileFilter: string;
  /** Creates the tree shows before the drive's tree lists them. */
  readonly pendingFiles: readonly PendingFile[];
  /** Why the last create failed; null once another starts. */
  readonly fileCreateError: string | null;
};

const withFiles = (state: UiState, files: Partial<FilesResources>): UiState => ({
  ...state,
  resources: { ...state.resources, ...files },
});

const without = (pending: readonly PendingFile[], key: string): readonly PendingFile[] =>
  pending.filter((file) => file.key !== key);

/**
 * The files section's view state. It lives in the shell store, apart from
 * the tree data, so revalidating the tree from the server never collapses
 * anything or loses a create in flight. Page ids are unique across drives.
 */
export const filesPlugin = {
  resources: (): FilesResources => ({
    expandedFileIds: [],
    fileFilter: '',
    pendingFiles: [],
    fileCreateError: null,
  }),
  transactions: {
    toggleFileFolder: (state: UiState, pageId: string): UiState => {
      const open = state.resources.expandedFileIds;
      return withFiles(state, {
        expandedFileIds: open.includes(pageId) ? open.filter((id) => id !== pageId) : [...open, pageId],
      });
    },
    /** Opens a page in the tree, leaving it open if it already is. */
    expandFileFolder: (state: UiState, pageId: string): UiState =>
      state.resources.expandedFileIds.includes(pageId)
        ? state
        : withFiles(state, { expandedFileIds: [...state.resources.expandedFileIds, pageId] }),
    setFileFilter: (state: UiState, fileFilter: string): UiState => withFiles(state, { fileFilter }),
    /** A create starts: its row shows at once, and the last failure clears. */
    beginFileCreate: (state: UiState, file: PendingFile): UiState =>
      withFiles(state, { pendingFiles: [...state.resources.pendingFiles, file], fileCreateError: null }),
    /** The create answered with the server's page id. */
    fileCreated: (state: UiState, { key, pageId }: { readonly key: string; readonly pageId: string }): UiState =>
      withFiles(state, {
        pendingFiles: state.resources.pendingFiles.map((file) => (file.key === key ? { ...file, pageId } : file)),
      }),
    /** The create failed: its row goes and the pane says why. */
    fileCreateFailed: (state: UiState, { key, error }: { readonly key: string; readonly error: string }): UiState =>
      withFiles(state, { pendingFiles: without(state.resources.pendingFiles, key), fileCreateError: error }),
    /** The drive's tree lists the page now: it alone draws the row. */
    fileCreateSettled: (state: UiState, key: string): UiState =>
      state.resources.pendingFiles.some((file) => file.key === key)
        ? withFiles(state, { pendingFiles: without(state.resources.pendingFiles, key) })
        : state,
  },
} satisfies UiSlice;
