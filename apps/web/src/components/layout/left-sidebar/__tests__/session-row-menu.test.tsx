/**
 * `RowMenu`: right-click and the 3-dots dropdown must show the SAME items,
 * rendered through ONE shared function — the structural fix for
 * `TaskTableRow`'s wart, where the two surfaces are hand-duplicated and can
 * silently drift apart.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Bot, Trash2 } from 'lucide-react';

const mockUseTouchDevice = vi.fn(() => false);
vi.mock('@/hooks/useTouchDevice', () => ({ useTouchDevice: () => mockUseTouchDevice() }));

import { RowMenu, type RowMenuItem } from '../session-row-menu';

beforeEach(() => {
  vi.clearAllMocks();
  mockUseTouchDevice.mockReturnValue(false);
});

const itemsFixture = (onFirst: () => void, onSecond: () => void): RowMenuItem[] => [
  { label: 'Rename', icon: Bot, onSelect: onFirst },
  { label: 'Delete', icon: Trash2, onSelect: onSecond, destructive: true, separatorBefore: true },
];

describe('RowMenu', () => {
  test('right-click opens a context menu with every item, in order', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <RowMenu items={itemsFixture(onFirst, onSecond)} menuLabel="Row actions">
        <span>row content</span>
      </RowMenu>,
    );

    fireEvent.contextMenu(screen.getByText('row content'));

    const menu = await screen.findByRole('menu');
    const options = within(menu).getAllByRole('menuitem');
    expect(options.map((el) => el.textContent)).toEqual(['Rename', 'Delete']);
  });

  test('the 3-dots dropdown shows the identical item set as the context menu', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const user = userEvent.setup();
    render(
      <RowMenu items={itemsFixture(onFirst, onSecond)} menuLabel="Row actions">
        <span>row content</span>
      </RowMenu>,
    );

    await user.click(screen.getByLabelText('Row actions'));

    const menu = await screen.findByRole('menu');
    const options = within(menu).getAllByRole('menuitem');
    expect(options.map((el) => el.textContent)).toEqual(['Rename', 'Delete']);
  });

  test('selecting an item from the context menu calls its handler', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const user = userEvent.setup();
    render(
      <RowMenu items={itemsFixture(onFirst, onSecond)} menuLabel="Row actions">
        <span>row content</span>
      </RowMenu>,
    );

    fireEvent.contextMenu(screen.getByText('row content'));
    await user.click(await screen.findByText('Delete'));

    expect(onSecond).toHaveBeenCalledTimes(1);
    expect(onFirst).not.toHaveBeenCalled();
  });

  test('selecting an item from the dropdown calls its handler', async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const user = userEvent.setup();
    render(
      <RowMenu items={itemsFixture(onFirst, onSecond)} menuLabel="Row actions">
        <span>row content</span>
      </RowMenu>,
    );

    await user.click(screen.getByLabelText('Row actions'));
    await user.click(await screen.findByText('Rename'));

    expect(onFirst).toHaveBeenCalledTimes(1);
    expect(onSecond).not.toHaveBeenCalled();
  });

  test('the 3-dots button is auto-revealed on a touch device', () => {
    mockUseTouchDevice.mockReturnValue(true);
    render(
      <RowMenu items={itemsFixture(vi.fn(), vi.fn())} menuLabel="Row actions">
        <span>row content</span>
      </RowMenu>,
    );

    expect(screen.getByLabelText('Row actions').className).toContain('opacity-100');
  });

  test('the 3-dots button is hover-revealed (opacity-0 at rest) off touch', () => {
    render(
      <RowMenu items={itemsFixture(vi.fn(), vi.fn())} menuLabel="Row actions">
        <span>row content</span>
      </RowMenu>,
    );

    expect(screen.getByLabelText('Row actions').className).toContain('opacity-0');
  });
});
