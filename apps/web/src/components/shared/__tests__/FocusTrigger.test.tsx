import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Drive } from '@pagespace/lib/types';

let params: { driveId?: string } = {};
vi.mock('next/navigation', () => ({
  useParams: () => params,
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const dialogSpy = vi.fn();
vi.mock('@/components/layout/navbar/DriveSwitcherDialog', () => ({
  default: ({ open }: { open: boolean }) => {
    dialogSpy(open);
    return open ? <div role="dialog" data-testid="drive-picker" /> : null;
  },
}));

import { FocusTrigger } from '../FocusTrigger';
import { useDriveStore } from '@/hooks/useDrive';

const buildDrive = (overrides: Partial<Drive> = {}): Drive => ({
  id: 'drive_eng',
  name: 'Engineering',
  slug: 'engineering',
  ownerId: 'user_1',
  isTrashed: false,
  trashedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  isOwned: true,
  ...overrides,
});

describe('FocusTrigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    params = {};
    useDriveStore.setState({ drives: [], currentDriveId: null, isLoading: false, lastFetched: Date.now() });
  });

  it('given All drives, should say so and describe the section in its accessible name', () => {
    render(<FocusTrigger section="tasks" />);

    const trigger = screen.getByRole('button', { name: 'Viewing tasks across all drives. Change focus.' });
    expect(trigger).toHaveTextContent('All drives');
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  });

  it('given a drive the store knows, should name it', () => {
    useDriveStore.setState({ drives: [buildDrive()] });

    params = { driveId: 'drive_eng' };

    render(<FocusTrigger section="files" />);

    expect(screen.getByRole('button', { name: 'Viewing files in Engineering. Change focus.' })).toHaveTextContent(
      'Engineering'
    );
  });

  it('given a drive the store has not loaded, should still be pressable', async () => {
    params = { driveId: 'drive_missing' };
    render(<FocusTrigger section="channels" />);

    const trigger = screen.getByRole('button', { name: /This drive/ });
    await userEvent.click(trigger);

    expect(screen.getByTestId('drive-picker')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('given a coarse pointer, the text variant should grow its hit area with padding, not height', () => {
    render(<FocusTrigger section="tasks" />);

    const cls = screen.getByRole('button').className;
    expect(cls).toMatch(/pointer-coarse:py-2/);
    expect(cls).toMatch(/pointer-coarse:-my-2/);
    expect(cls).not.toMatch(/\bh-\d/);
  });

  it('given the compact variant, should be icon-only at the size of its row and keep the words in its name', () => {
    useDriveStore.setState({ drives: [buildDrive()] });

    params = { driveId: 'drive_eng' };

    const { rerender } = render(<FocusTrigger section="calendar" variant="compact" size="sm" />);
    const small = screen.getByRole('button', { name: 'Viewing calendar in Engineering. Change focus.' });
    expect(small).not.toHaveTextContent('Engineering');
    expect(small.className).toMatch(/h-8 w-8/);

    rerender(<FocusTrigger section="calendar" variant="compact" size="md" />);
    expect(screen.getByRole('button').className).toMatch(/h-9 w-9/);
  });
});
