// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import PersonalizationSettingsPage from './page';
import { fetchWithAuth, patch } from '@/retained/lib/auth/auth-fetch';

const pushMock = vi.fn();

vi.mock('@/retained/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1' }, isLoading: false }),
}));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const patchMock = vi.mocked(patch);

type Personalization = {
  enabled: boolean;
  memoryFolderHref: string | null;
  pages: Array<{
    field: 'bio' | 'writingStyle' | 'rules';
    title: string;
    pageId: string | null;
    href: string | null;
    preview: string;
    isEmpty: boolean;
  }>;
};

const populated: Personalization = {
  enabled: true,
  memoryFolderHref: '/dashboard/home/memory',
  pages: [
    {
      field: 'bio',
      title: 'About You',
      pageId: 'p1',
      href: '/dashboard/d1/p1',
      preview: 'Founder at a small studio.',
      isEmpty: false,
    },
    {
      field: 'writingStyle',
      title: 'Communication',
      pageId: 'p2',
      href: '/dashboard/d1/p2',
      preview: 'Plain words, short sentences.',
      isEmpty: false,
    },
    {
      field: 'rules',
      title: 'Rules',
      pageId: 'p3',
      href: '/dashboard/d1/p3',
      preview: '',
      isEmpty: true,
    },
  ],
};

const respondWith = (personalization: Personalization) => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ personalization }),
  } as unknown as Response);
};

const renderPage = async () => {
  const view = render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PersonalizationSettingsPage />
    </SWRConfig>,
  );
  await screen.findByRole('heading', { level: 1, name: 'Personalization' });
  return view;
};

describe('PersonalizationSettingsPage (/account/personalization)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchMock.mockResolvedValue({} as Response);
  });

  afterEach(() => {
    cleanup();
  });

  test('renders the Use personalization in AI switch, checked when enabled', async () => {
    respondWith(populated);
    await renderPage();
    const sw = screen.getByRole('switch', { name: 'Use personalization in AI' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  test('renders the real memory page titles, previews and Edit or Write links', async () => {
    respondWith(populated);
    await renderPage();
    expect(screen.getByText('About You')).toBeTruthy();
    expect(screen.getByText('Communication')).toBeTruthy();
    expect(screen.getByText('Rules')).toBeTruthy();
    expect(screen.getByText('Founder at a small studio.')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: /^(Edit|Write)$/ });
    expect(buttons.map((b) => b.textContent)).toEqual(['Edit', 'Edit', 'Write']);
  });

  test('marks only the empty memory page with an Empty badge', async () => {
    respondWith(populated);
    await renderPage();
    const badges = screen.getAllByText('Empty');
    expect(badges).toHaveLength(1);
    const rulesRow = screen.getByText('Rules').closest('.px-4');
    expect(rulesRow?.textContent).toContain('Empty');
    const aboutRow = screen.getByText('About You').closest('.px-4');
    expect(aboutRow?.textContent).not.toContain('Empty');
  });

  test('links Stored as pages in Home › Memory to the Memory folder', async () => {
    respondWith(populated);
    await renderPage();
    const link = screen.getByRole('link', { name: 'Home › Memory' });
    expect(link.getAttribute('href')).toBe('/dashboard/home/memory');
    fireEvent.click(link);
    expect(pushMock).toHaveBeenCalledWith('/dashboard/home/memory');
  });

  test('Edit opens the page it belongs to', async () => {
    respondWith(populated);
    await renderPage();
    const aboutRow = screen.getByText('About You').closest('.px-4') as HTMLElement;
    fireEvent.click(within(aboutRow).getByRole('button', { name: 'Edit' }));
    expect(pushMock).toHaveBeenCalledWith('/dashboard/d1/p1');
  });

  test('toggling the switch off persists enabled false and dims the memory pages', async () => {
    respondWith(populated);
    await renderPage();
    const sw = screen.getByRole('switch', { name: 'Use personalization in AI' });
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith('/api/settings/personalization', { enabled: false });
    });
  });

  test('a disabled personalization renders the switch unchecked and the pages dimmed', async () => {
    respondWith({ ...populated, enabled: false });
    await renderPage();
    expect(screen.getByRole('switch', { name: 'Use personalization in AI' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('About You').closest('.opacity-60')).not.toBeNull();
  });

  test('no Back to Settings button and a single h1', async () => {
    respondWith(populated);
    await renderPage();
    expect(screen.queryByRole('button', { name: /back to settings/i })).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});
