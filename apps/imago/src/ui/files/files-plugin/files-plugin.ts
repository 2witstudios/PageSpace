import type { UiSlice, UiState } from '../../store/state';
import type { DocumentPatch } from '../document-edit/document-saver';

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

/** Text a document held when it closed and the server never got, with the revision it was made on. */
export type DocumentDraft = { readonly patch: DocumentPatch; readonly revision: number };

type FilesResources = {
  /** Pages expanded in the files tree. */
  readonly expandedFileIds: readonly string[];
  /** What the tree pane's filter holds. */
  readonly fileFilter: string;
  /** Creates the tree shows before the drive's tree lists them. */
  readonly pendingFiles: readonly PendingFile[];
  /** Why the last create failed; null once another starts. */
  readonly fileCreateError: string | null;
  /** Documents holding text the server does not have yet: SWR leaves their page alone meanwhile. */
  readonly editingDocumentIds: readonly string[];
  /** Unsaved text of documents that closed, by page id, restored when each opens again. */
  readonly documentDrafts: Readonly<Record<string, DocumentDraft>>;
};

const withFiles = (state: UiState, files: Partial<FilesResources>): UiState => ({
  ...state,
  resources: { ...state.resources, ...files },
});

/** Whether a document holds unsaved text: its page must not be revalidated over it. */
export const isEditingDocument = (state: UiState, pageId: string): boolean =>
  state.resources.editingDocumentIds.includes(pageId);

/** The draft a document closed with; undefined when it closed saved. */
export const documentDraftOf = (state: UiState, pageId: string): DocumentDraft | undefined =>
  Object.hasOwn(state.resources.documentDrafts, pageId) ? state.resources.documentDrafts[pageId] : undefined;

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
    editingDocumentIds: [],
    documentDrafts: {},
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
    /** A document now holds text the server does not have (classic's useEditingStore.startEditing). */
    beginDocumentEdit: (state: UiState, pageId: string): UiState =>
      isEditingDocument(state, pageId)
        ? state
        : withFiles(state, { editingDocumentIds: [...state.resources.editingDocumentIds, pageId] }),
    /** The server has everything the document holds again. */
    endDocumentEdit: (state: UiState, pageId: string): UiState =>
      isEditingDocument(state, pageId)
        ? withFiles(state, { editingDocumentIds: state.resources.editingDocumentIds.filter((id) => id !== pageId) })
        : state,
    /** A document closed holding text the server never got: keep it for when it opens again. */
    keepDocumentDraft: (
      state: UiState,
      { pageId, draft }: { readonly pageId: string; readonly draft: DocumentDraft },
    ): UiState => withFiles(state, { documentDrafts: { ...state.resources.documentDrafts, [pageId]: draft } }),
    /** The reopened document holds its draft again. */
    dropDocumentDraft: (state: UiState, pageId: string): UiState => {
      if (documentDraftOf(state, pageId) === undefined) return state;
      const { [pageId]: _taken, ...rest } = state.resources.documentDrafts;
      return withFiles(state, { documentDrafts: rest });
    },
  },
} satisfies UiSlice;
