// @vitest-environment jsdom
// Every Files hook that reads a page's SWR entry carries the editing pause:
// SWR's focus revalidation runs through whichever hook registered first for
// the key, so each one, mounted alone, must hold off while its document has
// unsaved text.
import { act, type ReactNode } from 'react';
import { useSWRConfig, type ScopedMutator } from 'swr';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { ImagoSWRProvider } from '@/api/swr-provider';
import { mount, unmountAll } from '../../test-support/dom';
import { fakeWeb } from '../../test-support/fake-web';
import { createInitialState } from '../../store/state';
import { setUiState } from '../../store/store';
import { dispatch, transactions } from '../../store/transactions';
import { pageRow } from '../file-model/fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

const { PageObject } = await import('./page-object');
const { FileObject } = await import('../file-object/file-object');
const { ClassicHandoff } = await import('../classic-handoff/classic-handoff');

beforeEach(() => {
  setUiState(createInitialState());
});

afterEach(unmountAll);

const PAGE = 'GET /api/pages/notes';

const pass = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const swr: { mutate: ScopedMutator | null } = { mutate: null };
function SWRProbe(): ReactNode {
  swr.mutate = useSWRConfig().mutate;
  return null;
}

const hooks: readonly [string, () => ReactNode][] = [
  ['PageObject', () => <PageObject driveId="d1" pageId="notes">{null}</PageObject>],
  ['FileObject', () => <FileObject driveId="d1" pageId="notes">{null}</FileObject>],
  ['ClassicHandoff', () => <ClassicHandoff driveId="d1" pageId="notes">{null}</ClassicHandoff>],
];

/** GETs a revalidation of the page made while it was edited, then once it was not. */
const revalidations = async (hook: () => ReactNode): Promise<[number, number]> => {
  const web = fakeWeb({
    [PAGE]: () => Response.json({ ...pageRow('notes', 'DOCUMENT'), content: '<p>x</p>', revision: 1 }),
  });
  mount(
    <ImagoSWRProvider client={web.client}>
      <SWRProbe />
      {hook()}
    </ImagoSWRProvider>,
  );
  await pass(30);
  const asked = () => web.count(PAGE);
  const before = asked();
  dispatch(transactions.beginDocumentEdit, { pageId: 'notes', viewId: 'v1' });
  await act(async () => {
    await swr.mutate?.('/api/pages/notes');
  });
  await pass(20);
  const whileEditing = asked() - before;
  dispatch(transactions.endDocumentEdit, { pageId: 'notes', viewId: 'v1' });
  await act(async () => {
    await swr.mutate?.('/api/pages/notes');
  });
  await pass(20);
  const after = asked() - before - whileEditing;
  unmountAll();
  return [whileEditing, after];
};

describe('the page key’s hooks', () => {
  test('each holds off revalidation while its document is edited', async () => {
    const actual: [string, [number, number]][] = [];
    for (const [name, hook] of hooks) actual.push([name, await revalidations(hook)]);
    assert({
      given: 'each Files hook on a page’s SWR entry alone, its document edited, then not',
      should: 'fetch nothing while it is edited, and revalidate again once it is not',
      actual,
      expected: hooks.map(([name]) => [name, [0, 1]]),
    });
  });
});
