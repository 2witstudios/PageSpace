/**
 * WHO ANSWERS THE QUICK-CREATE HOTKEY.
 *
 * `Alt+N` means "new page" everywhere except the Agents routes, where "new"
 * is a session — or the environment to run one in — and `AgentsSidebar`
 * registers its own handler for the same binding. Two handlers on one keystroke
 * is the failure this guards: the sidebar's half is tested at its own site, and
 * this is the half that has to stand down.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const mockUseParams = vi.fn<() => Record<string, string>>(() => ({ driveId: 'drive-1' }));
const mockUsePathname = vi.fn<() => string>(() => '/dashboard/drive-1/some-page');
vi.mock('next/navigation', () => ({
  useParams: () => mockUseParams(),
  usePathname: () => mockUsePathname(),
}));

const mockOpenQuickCreate = vi.fn();
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({
      quickCreateOpen: false,
      quickCreateParentOverride: undefined,
      openQuickCreate: mockOpenQuickCreate,
      closeQuickCreate: vi.fn(),
    }),
}));

vi.mock('swr', () => ({
  default: () => ({ data: undefined }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/hooks/usePageNavigation', () => ({ usePageNavigation: () => ({ navigateToPage: vi.fn() }) }));
vi.mock('@/hooks/useBreadcrumbs', () => ({ useBreadcrumbs: () => ({ breadcrumbs: [] }) }));
vi.mock('@/hooks/useDisplayPreferences', () => ({ useDisplayPreferences: () => ({ preferences: {} }) }));

import QuickCreatePalette from '../QuickCreatePalette';

const ALT_N = { key: 'Dead', code: 'KeyN', altKey: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  mockUseParams.mockReturnValue({ driveId: 'drive-1' });
});

describe('QuickCreatePalette hotkey', () => {
  test('opens on an ordinary drive route', () => {
    mockUsePathname.mockReturnValue('/dashboard/drive-1/page-1');
    render(<QuickCreatePalette />);

    fireEvent.keyDown(document, ALT_N);

    expect(mockOpenQuickCreate).toHaveBeenCalledWith(null);
  });

  test('stands down on a drive-scoped agents route — the sidebar answers it there', () => {
    mockUsePathname.mockReturnValue('/dashboard/drive-1/agents');
    render(<QuickCreatePalette />);

    fireEvent.keyDown(document, ALT_N);

    expect(mockOpenQuickCreate).not.toHaveBeenCalled();
  });

  test('stands down on the global agents console too', () => {
    mockUsePathname.mockReturnValue('/dashboard/agents');
    render(<QuickCreatePalette />);

    fireEvent.keyDown(document, ALT_N);

    expect(mockOpenQuickCreate).not.toHaveBeenCalled();
  });
});
