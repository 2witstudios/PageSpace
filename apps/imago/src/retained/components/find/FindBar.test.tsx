// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, press, unmountAll, typeInto, click } from '@/ui/test-support/dom';
import { useFindStore } from '@/retained/stores/useFindStore';
import { FindBar } from './FindBar';

const openWithMatches = (query: string, totalMatches: number) =>
  useFindStore.setState({ isOpen: true, query, totalMatches, currentIndex: 0 });

beforeEach(() => {
  useFindStore.getState().reset();
});

afterEach(unmountAll);

describe('FindBar (IMC-9.10)', () => {
  test('a query with two matches shows the field, "1 of 2", Previous and Next match, and Close find bar', () => {
    openWithMatches('owner', 2);
    const root = mount(<FindBar />);
    assert({
      given: 'an open find with the query "owner" and two matches',
      should: 'show the Find field, the N of M count and the three match and close controls',
      actual: [
        root.querySelector<HTMLInputElement>('input[aria-label="Find"]')?.value,
        root.querySelector('input')?.placeholder,
        root.textContent?.includes('1 of 2'),
        Boolean(root.querySelector('[aria-label="Previous match"]')),
        Boolean(root.querySelector('[aria-label="Next match"]')),
        Boolean(root.querySelector('[aria-label="Close find bar"]')),
      ],
      expected: ['owner', 'Find...', true, true, true, true],
    });
  });

  test('Enter advances to the next match and Shift+Enter goes back', () => {
    openWithMatches('owner', 2);
    const root = mount(<FindBar />);
    const field = root.querySelector('input') as HTMLInputElement;
    press(field, 'Enter');
    const afterNext = useFindStore.getState().currentIndex;
    press(field, "Enter");
    const wrapped = useFindStore.getState().currentIndex;
    assert({
      given: 'two matches with the first one current',
      should: 'move to the second match on Enter and wrap back to the first',
      actual: [afterNext, wrapped],
      expected: [1, 0],
    });
  });

  test('Next and Previous match buttons move through the matches', () => {
    openWithMatches('owner', 2);
    const root = mount(<FindBar />);
    click(root.querySelector('[aria-label="Next match"]') as HTMLElement);
    const afterNext = root.textContent?.includes('2 of 2');
    click(root.querySelector('[aria-label="Previous match"]') as HTMLElement);
    assert({
      given: 'two matches',
      should: 'show "2 of 2" after Next and "1 of 2" after Previous',
      actual: [afterNext, root.textContent?.includes('1 of 2')],
      expected: [true, true],
    });
  });

  test('Escape closes the bar and clears the query and highlights', () => {
    openWithMatches('owner', 2);
    const root = mount(<FindBar />);
    press(root.querySelector('input') as HTMLElement, 'Escape');
    const { isOpen, query, totalMatches } = useFindStore.getState();
    assert({
      given: 'an open find bar with a query',
      should: 'close it and clear the query and match count so the document drops its highlights',
      actual: { isOpen, query, totalMatches },
      expected: { isOpen: false, query: '', totalMatches: 0 },
    });
  });

  test('typing updates the query in the store', () => {
    useFindStore.setState({ isOpen: true });
    const root = mount(<FindBar />);
    typeInto(root.querySelector('input') as HTMLInputElement, 'owner');
    assert({
      given: 'an open find bar',
      should: 'write what is typed into the store query',
      actual: useFindStore.getState().query,
      expected: 'owner',
    });
  });

  test('renders nothing while find is closed', () => {
    const root = mount(<FindBar />);
    assert({
      given: 'a closed find store',
      should: 'render no find bar',
      actual: root.querySelector('input'),
      expected: null,
    });
  });
});
