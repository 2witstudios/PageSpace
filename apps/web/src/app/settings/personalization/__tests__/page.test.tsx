import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from '@/lib/memory/__tests__/riteway';
import PersonalizationSettingsPage from '../page';
import { useOrgReauthStore } from '@/stores/useOrgReauthStore';

/**
 * The personalization screen no longer edits content — that lives as pages in
 * the Home drive. It owns exactly one write (the enabled toggle) and otherwise
 * points the user at their pages, so these tests cover the toggle's write
 * discipline and that a user can actually reach the pages from here.
 */

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  push: vi.fn(),
  patch: vi.fn(),
  fetchWithAuth: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: mocks.useAuth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mocks.fetchWithAuth,
  patch: mocks.patch,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

let swrData: unknown = null;
const swrMutate = vi.fn();
vi.mock('swr', () => ({
  default: vi.fn(() => ({ data: swrData, mutate: swrMutate, isLoading: false })),
}));

function setData(overrides: Record<string, unknown> = {}) {
  swrData = {
    personalization: {
      enabled: true,
      memoryFolderHref: '/dashboard/drive-1/folder-1',
      pages: [
        {
          field: 'bio',
          title: 'About You',
          pageId: 'p-bio',
          href: '/dashboard/drive-1/p-bio',
          preview: 'Software engineer',
          isEmpty: false,
        },
        {
          field: 'writingStyle',
          title: 'Communication',
          pageId: 'p-style',
          href: '/dashboard/drive-1/p-style',
          preview: '',
          isEmpty: true,
        },
        {
          field: 'rules',
          title: 'Rules',
          pageId: 'p-rules',
          href: '/dashboard/drive-1/p-rules',
          preview: 'Never use emojis',
          isEmpty: false,
        },
      ],
      ...overrides,
    },
  };
}

describe('personalization settings page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, isLoading: false });
    mocks.patch.mockResolvedValue({});
    setData();
  });

  it('shows a link to each memory page', () => {
    render(<PersonalizationSettingsPage />);

    assert({
      given: 'three provisioned memory pages',
      should: 'offer an edit link for each',
      actual: screen.getAllByText('Edit page').length,
      expected: 3,
    });
  });

  it('sends the user to the page when they choose to edit it', () => {
    render(<PersonalizationSettingsPage />);
    fireEvent.click(screen.getAllByText('Edit page')[0]);

    assert({
      given: 'a click on the first page edit link',
      should: 'navigate to that page in the drive',
      actual: mocks.push.mock.calls[0]?.[0],
      expected: '/dashboard/drive-1/p-bio',
    });
  });

  it('writes the toggle exactly once, however fast it is clicked', async () => {
    // Overlapping PATCHes can settle out of order, leaving the server on the
    // OLDER value while the switch shows the newer one — a silent disagreement
    // about whether the profile is being injected into prompts at all.
    //
    // Asserts the OBSERVABLE guarantee (one request in flight at a time) rather
    // than a particular mechanism. Two things enforce it — the handler's early
    // return and the switch's `disabled` — and either alone is sufficient, so a
    // test that pinned one would just be testing the other by accident.
    let resolvePatch: (v: unknown) => void = () => {};
    mocks.patch.mockImplementation(() => new Promise((r) => { resolvePatch = r; }));

    render(<PersonalizationSettingsPage />);
    const toggle = screen.getByRole('switch');

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    assert({
      given: 'repeated toggling with the first write still in flight',
      should: 'have sent exactly one request',
      actual: mocks.patch.mock.calls.length,
      expected: 1,
    });

    resolvePatch({});
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());

    // And once it settles the control accepts input again — a guard that never
    // released would be indistinguishable from one that works, until a user
    // found they could not turn personalization back off.
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.patch.mock.calls.length).toBe(2));
  });

  it('restores the previous value when the write fails', async () => {
    mocks.patch.mockRejectedValue(new Error('nope'));
    render(<PersonalizationSettingsPage />);

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());

    assert({
      given: 'a failed toggle write',
      should: 'leave the switch showing the value the server still holds',
      actual: screen.getByRole('switch').getAttribute('aria-checked'),
      expected: 'true',
    });
  });

  it('says so when a page exists but has nothing in it', () => {
    render(<PersonalizationSettingsPage />);

    assert({
      given: 'a provisioned but empty memory page',
      should: 'invite the user to write in it rather than looking broken',
      actual: screen.getByText(/Nothing here yet/i) !== null,
      expected: true,
    });
  });
});

describe('personalization settings page when an org withholds the memory (D-OW-62)', () => {
  const withheldPage = (field: string, title: string, pageId: string) => ({
    field,
    title,
    pageId,
    href: `/dashboard/drive-1/${pageId}`,
    preview: '',
    isEmpty: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({ user: { id: 'u1' }, isLoading: false });
    useOrgReauthStore.getState().dismiss();
    swrData = {
      personalization: {
        enabled: true,
        memoryFolderHref: '/dashboard/drive-1/folder-1',
        pages: [
          withheldPage('bio', 'About You', 'p-bio'),
          withheldPage('writingStyle', 'Communication', 'p-style'),
          withheldPage('rules', 'Rules', 'p-rules'),
        ],
      },
      signInRequired: { code: 'org_strong_sign_in_required', orgIds: ['org_a'] },
    };
  });

  it('SEC-2 (partial) says the memory is withheld, not empty, and offers the passkey prompt', () => {
    render(<PersonalizationSettingsPage />);

    assert({
      given: 'memory an org sign-in policy withholds from this sign-in',
      should: 'explain why it is hidden',
      actual: screen.getByText(/Your AI memory is hidden because an organization it draws from requires strong sign-in \(passkey\)/) !== null,
      expected: true,
    });
    assert({
      given: 'withheld memory pages',
      should: 'mark each page withheld instead of calling it empty',
      actual: [screen.getAllByText(/Hidden until you sign in as your organization asks/).length, screen.queryByText(/Nothing here yet/i)],
      expected: [3, null],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use your passkey' }));

    assert({
      given: 'the person choosing to unlock',
      should: 'open the re-authentication prompt with the passkey requirement for the refusing org',
      actual: useOrgReauthStore.getState().denials,
      expected: [{ code: 'org_strong_sign_in_required', orgId: 'org_a' }],
    });
  });

  it('shows no withheld notice when the memory is served', () => {
    setData();
    render(<PersonalizationSettingsPage />);

    assert({
      given: 'memory every org admits',
      should: 'show the previews with no withheld notice',
      actual: [screen.queryByText(/is hidden because/), screen.getByText('Software engineer') !== null],
      expected: [null, true],
    });
  });
});
