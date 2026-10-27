// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb, type FakeRoute } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { getUiState, setUiState } from '../../store/store';
import { pageRow } from '../file-model/fixtures';
import type { FileNode } from '../file-model/file-node';
import { isCreatingIn, NEW_DOCUMENT_TITLE, useCreateFile } from './create-file';

beforeEach(() => setUiState(createInitialState()));

afterEach(unmountAll);

const CREATE = 'POST /api/pages';

const archive: FileNode = { id: 'archive', name: 'Archive', kind: 'folder', pageType: 'FOLDER', count: 0, children: [] };

/** A promise the test settles by hand, so a create can be held in flight. */
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

type Create = () => Promise<void>;

/** One surface's + action (the tree pane's, or a folder browser's), handed to the test. */
function CreateFile({ driveId, expose }: { readonly driveId: string; readonly expose: (create: Create) => void }) {
  expose(
    useCreateFile({ driveId, nodes: [archive], selectedId: 'archive', revalidate: () => {}, open: () => {} }),
  );
  return null;
}

/** Mounts one surface per drive id given, all over one fake apps/web; returns each one's + action. */
const surfaces = (routes: Record<string, FakeRoute>, driveIds: readonly string[]) => {
  const web = fakeWeb(routes);
  const creates: Create[] = [];
  mount(
    <ImagoSWRProvider client={web.client}>
      {driveIds.map((driveId, index) => (
        <CreateFile
          key={`${driveId}-${index}`}
          driveId={driveId}
          expose={(create) => {
            creates[index] = create;
          }}
        />
      ))}
    </ImagoSWRProvider>,
  );
  return { web, creates };
};

const created = (driveId: string) =>
  Response.json(pageRow(`p-${driveId}`, 'DOCUMENT', { parentId: 'archive', title: NEW_DOCUMENT_TITLE }), { status: 201 });

/** Starts every create in one tick, as two quick presses do before React draws + off. */
const pressAll = (creates: readonly Create[]): Promise<void>[] => creates.map((create) => create());

describe('useCreateFile() one create per drive', () => {
  test('two presses in one tick on one surface', async () => {
    const answer = deferred<Response>();
    const { web, creates } = surfaces({ [CREATE]: () => answer.promise }, ['d1']);
    const [create] = creates;
    const pressed = pressAll([create, create]);
    const during = getUiState().resources.pendingFiles.length;
    answer.resolve(created('d1'));
    await act(() => Promise.all(pressed));

    assert({
      given: '+ called twice before React redraws it off',
      should: 'turn the second call away while the first is in flight: one row, one create',
      actual: [during, web.writes().length],
      expected: [1, 1],
    });
  });

  test('two surfaces on one drive', async () => {
    const answer = deferred<Response>();
    const { web, creates } = surfaces({ [CREATE]: () => answer.promise }, ['d1', 'd1']);
    const pressed = pressAll(creates);
    const during = getUiState().resources.pendingFiles.length;
    answer.resolve(created('d1'));
    await act(() => Promise.all(pressed));

    assert({
      given: 'the tree pane’s + and a folder browser’s New page pressed in one tick for the same drive',
      should: 'make one create between them, since the guard belongs to the drive rather than to a mount',
      actual: [during, web.writes().length],
      expected: [1, 1],
    });
  });

  test('two drives', async () => {
    const answers = new Map([
      ['d1', deferred<Response>()],
      ['d2', deferred<Response>()],
    ]);
    const { web, creates } = surfaces(
      {
        [CREATE]: (request) => {
          const { driveId } = request.body as { driveId: string };
          return answers.get(driveId)?.promise ?? Promise.reject(new Error(`no drive ${driveId}`));
        },
      },
      ['d1', 'd2'],
    );
    const pressed = pressAll(creates);
    const during = getUiState().resources.pendingFiles.map((file) => file.driveId);
    answers.get('d1')?.resolve(created('d1'));
    answers.get('d2')?.resolve(created('d2'));
    await act(() => Promise.all(pressed));

    assert({
      given: 'creates started in one tick in two different drives',
      should: 'let each drive’s create through: the guard holds one drive, not every drive',
      actual: [during, web.writes().map((request) => (request.body as { driveId: string }).driveId)],
      expected: [['d1', 'd2'], ['d1', 'd2']],
    });
  });

  test('the guard opens again once the create answers', async () => {
    const { web, creates } = surfaces({ [CREATE]: () => created('d1') }, ['d1']);
    const [create] = creates;
    await act(() => create());
    await act(() => create());

    assert({
      given: 'a second press after the first create answered',
      should: 'create again',
      actual: web.writes().length,
      expected: 2,
    });
  });
});

describe('isCreatingIn()', () => {
  test('which drive has a create in flight', () => {
    const pending = [
      { key: 'a', driveId: 'd1', parentId: null, title: 'T', pageId: null, knownIds: [] },
      { key: 'b', driveId: 'd2', parentId: null, title: 'T', pageId: 'p2', knownIds: [] },
    ];
    assert({
      given: 'an unanswered create in d1 and an answered one in d2',
      should: 'hold d1 only, and nothing else',
      actual: [isCreatingIn(pending, 'd1'), isCreatingIn(pending, 'd2'), isCreatingIn(pending, 'd3')],
      expected: [true, false, false],
    });
  });
});
