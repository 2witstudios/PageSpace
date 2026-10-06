import { beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { createInitialState, type UiState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import { documentDraftOf, filesPlugin, isEditingDocument, type PendingFile } from './files-plugin';

const {
  toggleFileFolder,
  expandFileFolder,
  setFileFilter,
  beginFileCreate,
  fileCreated,
  fileCreateFailed,
  fileCreateSettled,
} = filesPlugin.transactions;

const withExpanded = (expandedFileIds: readonly string[]): UiState => {
  const state = createInitialState();
  return { ...state, resources: { ...state.resources, expandedFileIds } };
};

beforeEach(() => {
  setUiState(createInitialState());
});

describe('toggleFileFolder()', () => {
  test('the empty shell', () => {
    assert({
      given: 'a new shell',
      should: 'have no folder expanded',
      actual: createInitialState().resources.expandedFileIds,
      expected: [],
    });
  });

  test('expanding', () => {
    assert({
      given: 'f1 expanded and f2 toggled',
      should: 'expand f2 too',
      actual: toggleFileFolder(withExpanded(['f1']), 'f2').resources.expandedFileIds,
      expected: ['f1', 'f2'],
    });
  });

  test('collapsing', () => {
    assert({
      given: 'f1 and f2 expanded and f1 toggled',
      should: 'keep only f2 expanded',
      actual: toggleFileFolder(withExpanded(['f1', 'f2']), 'f1').resources.expandedFileIds,
      expected: ['f2'],
    });
  });

  test('pure', () => {
    const state = withExpanded(['f1']);
    toggleFileFolder(state, 'f2');

    assert({
      given: 'a snapshot toggled into a new one',
      should: 'leave the old snapshot untouched',
      actual: state.resources.expandedFileIds,
      expected: ['f1'],
    });
  });

  test('through the shell', () => {
    dispatch(transactions.toggleFileFolder, 'f1');

    assert({
      given: 'the transaction dispatched through the shell store',
      should: 'record the expansion in the store',
      actual: getUiState().resources.expandedFileIds,
      expected: ['f1'],
    });
  });
});

const pending = (key: string, overrides: Partial<PendingFile> = {}): PendingFile => ({
  key,
  driveId: 'd1',
  parentId: 'f1',
  title: 'Untitled Document',
  pageId: null,
  knownIds: ['doc'],
  ...overrides,
});

describe('expandFileFolder()', () => {
  test('opening a closed page', () => {
    assert({
      given: 'f1 expanded and f2 opened',
      should: 'expand f2 too',
      actual: expandFileFolder(withExpanded(['f1']), 'f2').resources.expandedFileIds,
      expected: ['f1', 'f2'],
    });
  });

  test('an open page stays open', () => {
    const state = withExpanded(['f1']);
    assert({
      given: 'f1 already expanded and opened again',
      should: 'leave the snapshot as it is',
      actual: expandFileFolder(state, 'f1') === state,
      expected: true,
    });
  });
});

describe('setFileFilter()', () => {
  test('typing a filter', () => {
    assert({
      given: 'the empty shell and a typed filter',
      should: 'start with no filter and hold what was typed',
      actual: [createInitialState().resources.fileFilter, setFileFilter(createInitialState(), 'road').resources.fileFilter],
      expected: ['', 'road'],
    });
  });
});

describe('file creates', () => {
  test('a create starts', () => {
    const failed = { ...createInitialState(), resources: { ...createInitialState().resources, fileCreateError: 'No' } };
    const next = beginFileCreate(failed, pending('tmp-1'));
    assert({
      given: 'a failed create, then a new one',
      should: 'hold the new create and clear the old failure',
      actual: [next.resources.pendingFiles, next.resources.fileCreateError],
      expected: [[pending('tmp-1')], null],
    });
  });

  test('the server names the page', () => {
    const started = beginFileCreate(beginFileCreate(createInitialState(), pending('tmp-1')), pending('tmp-2'));
    assert({
      given: 'two creates in flight and the first answered as p9',
      should: 'name only the first',
      actual: fileCreated(started, { key: 'tmp-1', pageId: 'p9' }).resources.pendingFiles,
      expected: [pending('tmp-1', { pageId: 'p9' }), pending('tmp-2')],
    });
  });

  test('a create fails', () => {
    const started = beginFileCreate(createInitialState(), pending('tmp-1'));
    const next = fileCreateFailed(started, { key: 'tmp-1', error: 'You cannot add pages here.' });
    assert({
      given: 'a create the server refused',
      should: 'drop its row and keep why',
      actual: [next.resources.pendingFiles, next.resources.fileCreateError],
      expected: [[], 'You cannot add pages here.'],
    });
  });

  test('the tree lists the page', () => {
    const started = beginFileCreate(createInitialState(), pending('tmp-1', { pageId: 'p9' }));
    const settled = createInitialState();
    assert({
      given: 'a create the drive tree now lists, and one already settled',
      should: 'drop it once, and leave the snapshot alone the second time',
      actual: [
        fileCreateSettled(started, 'tmp-1').resources.pendingFiles,
        fileCreateSettled(settled, 'tmp-1') === settled,
      ],
      expected: [[], true],
    });
  });

  test('through the shell', () => {
    dispatch(transactions.beginFileCreate, pending('tmp-1'));
    dispatch(transactions.fileCreated, { key: 'tmp-1', pageId: 'p9' });
    assert({
      given: 'a create begun and answered through the shell store',
      should: 'record the named create in the store',
      actual: getUiState().resources.pendingFiles,
      expected: [pending('tmp-1', { pageId: 'p9' })],
    });
  });
});

describe('filesPlugin slice', () => {
  test('its own resources and transactions', () => {
    assert({
      given: 'the files slice',
      should: 'start with nothing expanded, filtered, pending, failed, being edited or kept, and own the files transactions',
      actual: [filesPlugin.resources(), Object.keys(filesPlugin.transactions)],
      expected: [
        {
          expandedFileIds: [],
          fileFilter: '',
          pendingFiles: [],
          fileCreateError: null,
          editingDocuments: [],
          documentDrafts: {},
        },
        [
          'toggleFileFolder',
          'expandFileFolder',
          'setFileFilter',
          'beginFileCreate',
          'fileCreated',
          'fileCreateFailed',
          'fileCreateSettled',
          'beginDocumentEdit',
          'endDocumentEdit',
          'keepDocumentDraft',
          'dropDocumentDraft',
        ],
      ],
    });
  });
});

describe('documents being edited', () => {
  const v1 = { pageId: 'p1', viewId: 'v1' };
  const v2 = { pageId: 'p1', viewId: 'v2' };

  test('beginning and ending an edit', () => {
    const { beginDocumentEdit, endDocumentEdit } = filesPlugin.transactions;
    const fresh = createInitialState();
    const editing = beginDocumentEdit(fresh, v1);
    const again = beginDocumentEdit(editing, v1);
    const ended = endDocumentEdit(editing, v1);
    assert({
      given: 'a new shell, a document edit begun twice by one view, then ended',
      should: 'mark the page as edited once, keep the snapshot when nothing changes, and clear it at the end',
      actual: [
        isEditingDocument(fresh, 'p1'),
        isEditingDocument(editing, 'p1'),
        isEditingDocument(editing, 'p2'),
        again === editing,
        isEditingDocument(ended, 'p1'),
        endDocumentEdit(fresh, v1) === fresh,
      ],
      expected: [false, true, false, true, false, true],
    });
  });

  test('two views of one page', () => {
    const { beginDocumentEdit, endDocumentEdit } = filesPlugin.transactions;
    const both = beginDocumentEdit(beginDocumentEdit(createInitialState(), v1), v2);
    const oldEnded = endDocumentEdit(both, v1);
    assert({
      given: 'a closed view of a page ending its edit while a reopened view of it still edits',
      should: 'keep the page edited until the reopened view ends too',
      actual: [isEditingDocument(oldEnded, 'p1'), isEditingDocument(endDocumentEdit(oldEnded, v2), 'p1')],
      expected: [true, false],
    });
  });

  test('through the shell store', () => {
    dispatch(transactions.beginDocumentEdit, v1);
    const during = isEditingDocument(getUiState(), 'p1');
    dispatch(transactions.endDocumentEdit, v1);
    assert({
      given: 'the edit transactions dispatched to the shell store',
      should: 'reach the files slice',
      actual: [during, isEditingDocument(getUiState(), 'p1')],
      expected: [true, false],
    });
  });
});

describe('drafts kept for documents that closed unsaved', () => {
  test('keeping and dropping a draft', () => {
    const { keepDocumentDraft, dropDocumentDraft } = filesPlugin.transactions;
    const fresh = createInitialState();
    const draft = { patch: { content: '<p>mine</p>' }, revision: 3 };
    const kept = keepDocumentDraft(fresh, { pageId: 'p1', draft });
    const dropped = dropDocumentDraft(kept, 'p1');
    assert({
      given: 'a document closed with text the server never got, then reopened',
      should: 'keep its draft under its page until the reopened document takes it',
      actual: [
        documentDraftOf(fresh, 'p1'),
        documentDraftOf(kept, 'p1'),
        documentDraftOf(kept, 'p2'),
        documentDraftOf(dropped, 'p1'),
        dropDocumentDraft(fresh, 'p1') === fresh,
      ],
      expected: [undefined, draft, undefined, undefined, true],
    });
  });
});
