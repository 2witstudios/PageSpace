// @vitest-environment jsdom
import { afterEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import type { Drive } from '@pagespace/lib/types';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { AccountTrashView, type AccountTrashViewProps } from './account-trash';

afterEach(unmountAll);

const drive = (overrides: Partial<Drive> & Pick<Drive, 'id' | 'name'>): Drive => ({
  slug: overrides.id,
  ownerId: 'me',
  isTrashed: true,
  trashedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  role: 'OWNER',
  lastAccessedAt: null,
  ...overrides,
});

const old = drive({ id: 'a', name: 'Old Client Work' });

const view = (overrides: Partial<AccountTrashViewProps> = {}) => {
  const mocks = {
    onRestore: vi.fn(),
    onAskDelete: vi.fn(),
    onTyped: vi.fn(),
    onCancelDelete: vi.fn(),
    onDelete: vi.fn(),
  };
  const base = { drives: [old], confirmingId: null, typed: '' };
  return { props: mocks, container: mount(<AccountTrashView {...base} {...mocks} {...overrides} />) };
};

const button = (container: HTMLElement, name: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === name || item.getAttribute('aria-label') === name);
  if (found === undefined) throw new Error(`${name} is missing`);
  return found;
};

describe('AccountTrashView', () => {
  test('lists each trashed drive with its name, its trashed date, and Restore and Delete permanently', () => {
    const { container } = view();
    assert({
      given: 'one trashed drive',
      should: 'show the name, Trashed with a date, Restore and the icon Delete permanently button, and no page count or countdown',
      actual: {
        h1: container.querySelector('h1')?.textContent,
        name: container.querySelector('.truncate')?.textContent,
        when: container.textContent?.includes('Trashed '),
        restore: button(container, 'Restore').textContent,
        remove: button(container, 'Delete permanently').getAttribute('aria-label'),
        pages: /\d+ pages/.test(container.textContent ?? ''),
        countdown: container.textContent?.includes('Deletes in'),
      },
      expected: {
        h1: 'Trashed drives',
        name: 'Old Client Work',
        when: true,
        restore: 'Restore',
        remove: 'Delete permanently',
        pages: false,
        countdown: false,
      },
    });
  });

  test('Restore reports the drive it was pressed on', () => {
    const { container, props } = view();
    click(button(container, 'Restore'));
    assert({
      given: 'a press on Restore',
      should: 'report that drive',
      actual: props.onRestore.mock.calls.map((call) => call[0].id),
      expected: ['a'],
    });
  });

  test('the confirm form is absent until Delete permanently is pressed', () => {
    const { container } = view();
    assert({
      given: 'no confirmation open',
      should: 'show no confirm form',
      actual: container.querySelector('form[aria-label="Confirm permanent delete"]'),
      expected: null,
    });
  });

  test('with the confirm form open, Delete permanently stays disabled until the typed name matches', () => {
    const { container } = view({ confirmingId: 'a', typed: 'Old Client' });
    const submit = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
    if (submit === null) throw new Error('confirm button is missing');
    assert({
      given: 'a partial name typed into the confirm form',
      should: 'keep the confirm button disabled',
      actual: { disabled: submit.disabled, form: container.querySelector('form')?.getAttribute('aria-label') },
      expected: { disabled: true, form: 'Confirm permanent delete' },
    });
  });

  test('a matching name enables the confirm button, and pressing it reports the drive', () => {
    const { container, props } = view({ confirmingId: 'a', typed: 'old client work' });
    const submit = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
    if (submit === null) throw new Error('confirm button is missing');
    click(submit);
    assert({
      given: 'the typed name matching the drive’s name',
      should: 'enable the confirm button and report the drive when pressed',
      actual: { disabled: submit.disabled, deleted: props.onDelete.mock.calls.map((call) => call[0].id) },
      expected: { disabled: false, deleted: ['a'] },
    });
  });

  test('typing into the confirm field reports the text', () => {
    const { container, props } = view({ confirmingId: 'a', typed: '' });
    const input = container.querySelector('input');
    if (input === null) throw new Error('confirm input is missing');
    typeInto(input, 'Old');
    assert({
      given: 'text typed into the confirm field',
      should: 'report the new value',
      actual: props.onTyped.mock.calls,
      expected: [['Old']],
    });
  });

  test('Cancel closes the confirmation', () => {
    const { container, props } = view({ confirmingId: 'a' });
    click(button(container, 'Cancel'));
    assert({
      given: 'a press on Cancel',
      should: 'ask for the confirmation to close',
      actual: props.onCancelDelete.mock.calls.length,
      expected: 1,
    });
  });

  test('with no trashed drives it says so and lists nothing', () => {
    const { container } = view({ drives: [] });
    assert({
      given: 'an empty trash',
      should: 'show the empty line and no group',
      actual: { text: container.textContent?.includes('No trashed drives.'), group: container.querySelector('[role="group"]') },
      expected: { text: true, group: null },
    });
  });
});
