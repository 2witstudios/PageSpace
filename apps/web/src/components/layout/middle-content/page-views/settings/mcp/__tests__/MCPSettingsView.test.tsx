import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const fetchWithAuthMock = vi.fn();
const postMock = vi.fn();
const patchMock = vi.fn();
const delMock = vi.fn();

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args),
  post: (...args: unknown[]) => postMock(...args),
  patch: (...args: unknown[]) => patchMock(...args),
  del: (...args: unknown[]) => delMock(...args),
}));

import MCPSettingsView from '../MCPSettingsView';
import { toast } from 'sonner';
import { startAuthentication } from '@simplewebauthn/browser';

const STEP_UP_TOKEN = 'ps_stepup_test';

// Default step-up mock: a successful WebAuthn ceremony. `postMock` also
// serves the real /api/auth/mcp-tokens(...) calls further down, so this
// dispatches on URL and lets tests override per-endpoint as needed.
const mockSuccessfulWebauthnStepUp = () => {
  vi.mocked(startAuthentication).mockResolvedValue({} as never);
  postMock.mockImplementation((url: string) => {
    if (url === '/api/auth/step-up/webauthn/options') {
      return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
    }
    if (url === '/api/auth/step-up/webauthn/verify') {
      return Promise.resolve({ stepUpToken: STEP_UP_TOKEN });
    }
    throw new Error(`unexpected post to ${url}`);
  });
};

// jsdom doesn't implement these; Radix Select's pointer-interaction internals need them.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

const DRIVE_ONE = { id: 'drive-1', name: 'Drive One', slug: 'drive-one', role: 'OWNER' as const };
const DRIVE_TWO = { id: 'drive-2', name: 'Drive Two', slug: 'drive-two', role: 'OWNER' as const };
const DRIVE_MEMBER_ONLY = { id: 'drive-3', name: 'Drive Three', slug: 'drive-three', role: 'MEMBER' as const };

const CUSTOM_ROLE = { id: 'role-support', name: 'Support', color: 'blue' };

const tokenA = () => ({
  id: 'token-1',
  name: 'Token A',
  lastUsed: null,
  createdAt: '2026-01-01T00:00:00Z',
  isScoped: true,
  driveScopes: [{ id: DRIVE_ONE.id, name: DRIVE_ONE.name, role: null, customRoleId: null, customRoleName: null }],
});

const tokenB = () => ({
  id: 'token-2',
  name: 'Token B',
  lastUsed: null,
  createdAt: '2026-01-01T00:00:00Z',
  isScoped: true,
  driveScopes: [{ id: DRIVE_TWO.id, name: DRIVE_TWO.name, role: null, customRoleId: null, customRoleName: null }],
});

const unscopedToken = () => ({
  id: 'token-unscoped',
  name: 'All-Drives Token',
  lastUsed: null,
  createdAt: '2026-01-01T00:00:00Z',
  isScoped: false,
  driveScopes: [],
});

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const cannedFetch = (tokens: unknown[], drives: unknown[] = [DRIVE_ONE, DRIVE_TWO]) =>
  fetchWithAuthMock.mockImplementation(async (...args: unknown[]) => {
    const url = String(args[0]);
    if (url.startsWith('/api/auth/mcp-tokens')) {
      return jsonResponse(tokens);
    }
    if (/\/api\/drives\/[^/]+\/roles$/.test(url)) {
      return jsonResponse({ roles: [CUSTOM_ROLE] });
    }
    if (url.startsWith('/api/drives')) {
      return jsonResponse(drives);
    }
    return jsonResponse({});
  });

const renderView = async (tokens: unknown[] = [tokenA(), tokenB()], drives: unknown[] = [DRIVE_ONE, DRIVE_TWO]) => {
  cannedFetch(tokens, drives);
  render(<MCPSettingsView />);
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Your Tokens' })).toBeInTheDocument());
};

const getCardFor = (tokenName: string) =>
  screen.getByText(tokenName).closest('.p-4') as HTMLElement;

// Radix Select portals its listbox to document.body, as a sibling of the Dialog's
// own portal — not a descendant — so options must be queried at the document level.
const selectRoleOption = async (driveLabel: string, optionName: RegExp) => {
  await userEvent.click(screen.getByRole('combobox', { name: new RegExp(`role for ${driveLabel}`, 'i') }));
  await userEvent.click(await screen.findByRole('option', { name: optionName }));
};

describe('MCPSettingsView — edit token drive scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSuccessfulWebauthnStepUp();
  });

  it('renders an edit-scopes button per token row alongside delete', async () => {
    await renderView();

    const cardA = getCardFor('Token A');
    expect(within(cardA).getByRole('button', { name: /edit token scopes/i })).toBeInTheDocument();
    expect(within(cardA).getAllByRole('button')).toHaveLength(2); // edit + delete
  });

  it('pre-checks boxes matching the token’s current drive scopes when opened', async () => {
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));

    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    expect(within(dialog).getByLabelText('Drive One')).toBeChecked();
    expect(within(dialog).getByLabelText('Drive Two')).not.toBeChecked();
  });

  it('shows a role select (defaulting to inherit) for each checked drive', async () => {
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });

    const roleSelect = within(dialog).getByRole('combobox', { name: /role for drive one/i });
    expect(roleSelect).toHaveTextContent(/inherit/i);
    // Drive Two isn't checked, so it has no role select yet.
    expect(within(dialog).queryByRole('combobox', { name: /role for drive two/i })).not.toBeInTheDocument();
  });

  it('submits the updated drives array (role + customRoleId) via patch, including the explicit empty-array case', async () => {
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-1', {
        drives: [
          { id: DRIVE_ONE.id, role: null, customRoleId: undefined },
          { id: DRIVE_TWO.id, role: null, customRoleId: undefined },
        ],
        stepUpToken: STEP_UP_TOKEN,
      })
    );

    // Clearing all selections submits an explicit empty array, not an omitted field.
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog2 = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog2).getByRole('button', { name: /clear selection/i }));
    await userEvent.click(within(dialog2).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-1', { drives: [], stepUpToken: STEP_UP_TOKEN })
    );
  });

  it('lets the caller pick Admin for a drive they own, and sends it in the PATCH body', async () => {
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });

    await selectRoleOption('drive one', /^admin$/i);
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-1', {
        drives: [{ id: DRIVE_ONE.id, role: 'ADMIN', customRoleId: undefined }],
        stepUpToken: STEP_UP_TOKEN,
      })
    );
  });

  it('hides the Admin option for a drive where the caller is only a Member', async () => {
    await renderView([{ ...tokenA(), driveScopes: [{ id: DRIVE_MEMBER_ONLY.id, name: DRIVE_MEMBER_ONLY.name, role: null, customRoleId: null, customRoleName: null }] }], [DRIVE_MEMBER_ONLY]);

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    await screen.findByRole('dialog', { name: /edit token drive scopes/i });

    await userEvent.click(screen.getByRole('combobox', { name: /role for drive three/i }));
    expect(await screen.findByRole('option', { name: /^member$/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^admin$/i })).not.toBeInTheDocument();
  });

  it('still shows Admin as the current value on a Member-ceiling drive if it was already granted', async () => {
    // Edge case: Admin was granted while the caller had higher access, and they've
    // since been downgraded to Member on that drive. The scope is still in effect
    // server-side, so the picker must reflect it rather than showing a blank trigger.
    await renderView(
      [{ ...tokenA(), driveScopes: [{ id: DRIVE_MEMBER_ONLY.id, name: DRIVE_MEMBER_ONLY.name, role: 'ADMIN', customRoleId: null, customRoleName: null }] }],
      [DRIVE_MEMBER_ONLY]
    );

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    await screen.findByRole('dialog', { name: /edit token drive scopes/i });

    const roleSelect = screen.getByRole('combobox', { name: /role for drive three/i });
    expect(roleSelect).toHaveTextContent(/^admin$/i);
  });

  it('lists the drive’s custom roles (fetched from /api/drives/:id/roles) and submits the chosen customRoleId', async () => {
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(`/api/drives/${DRIVE_ONE.id}/roles`));
    await selectRoleOption('drive one', /support/i);
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-1', {
        drives: [{ id: DRIVE_ONE.id, role: 'MEMBER', customRoleId: CUSTOM_ROLE.id }],
        stepUpToken: STEP_UP_TOKEN,
      })
    );
  });

  it('on success closes the dialog, toasts, and updates the row without a refetch', async () => {
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();
    fetchWithAuthMock.mockClear();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/scopes updated/i)));
    expect(screen.queryByRole('dialog', { name: /edit token drive scopes/i })).not.toBeInTheDocument();
    expect(within(getCardFor('Token A')).getByText(/Access:/)).toHaveTextContent('Drive One, Drive Two');

    // No refetch of the token list happened — the row updated locally, not from a refetch.
    const refetchCalls = fetchWithAuthMock.mock.calls.filter(([url]) => String(url).startsWith('/api/auth/mcp-tokens'));
    expect(refetchCalls).toHaveLength(0);
  });

  it('shows an Admin badge in the row summary once a drive scope is granted Admin', async () => {
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await selectRoleOption('drive one', /^admin$/i);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(within(getCardFor('Token A')).getByText(/Access:/)).toHaveTextContent('Drive One (Admin)'));
  });

  it('labels an explicit Member scope distinctly from inherit in the row summary', async () => {
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await selectRoleOption('drive one', /^member$/i);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    // Distinguishes an explicit Member downgrade from the default "inherit my access"
    // (role: null), which renders with no suffix at all.
    await waitFor(() => expect(within(getCardFor('Token A')).getByText(/Access:/)).toHaveTextContent('Drive One (Member)'));
  });

  it('on rejection keeps the dialog open, toasts an error, and leaves token state unchanged', async () => {
    patchMock.mockRejectedValueOnce(new Error('Some drives are not accessible'));
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Some drives are not accessible'));
    expect(screen.getByRole('dialog', { name: /edit token drive scopes/i })).toBeInTheDocument();
    expect(within(getCardFor('Token A')).getByText(/Access:/)).toHaveTextContent('Drive One');
  });

  it('warns before silently converting an unscoped (all-drives) token to zero access', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderView([unscopedToken()]);

    await userEvent.click(within(getCardFor('All-Drives Token')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    expect(dialog).toHaveTextContent(/currently has access to all your drives/i);

    // Pressing Save with nothing selected must prompt for confirmation before
    // silently downgrading an all-drives token to a zero-drive token.
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/ALL your drives/));
    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: /edit token drive scopes/i })).toBeInTheDocument();

    // Confirming proceeds with the explicit empty-array revoke.
    confirmSpy.mockReturnValue(true);
    patchMock.mockResolvedValueOnce({ id: 'token-unscoped', name: 'All-Drives Token', driveScopes: [] });
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-unscoped', {
        drives: [],
        stepUpToken: STEP_UP_TOKEN,
      })
    );
    confirmSpy.mockRestore();
  });

  it('does not prompt for confirmation when saving an already-scoped token with a non-empty selection', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(patchMock).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('editing token A does not affect token B’s checkbox state', async () => {
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    let dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));
    expect(within(dialog).getByLabelText('Drive One')).toBeChecked();
    expect(within(dialog).getByLabelText('Drive Two')).toBeChecked();
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    await userEvent.click(within(getCardFor('Token B')).getByRole('button', { name: /edit token scopes/i }));
    dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    expect(within(dialog).getByLabelText('Drive One')).not.toBeChecked();
    expect(within(dialog).getByLabelText('Drive Two')).toBeChecked();
  });
});

describe('MCPSettingsView — create token step-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.location.hash = '';
    mockSuccessfulWebauthnStepUp();
  });

  const openCreateDialog = async () => {
    await userEvent.click(screen.getByRole('button', { name: /^create token$/i }));
    return screen.findByRole('dialog', { name: /create new mcp token/i });
  };

  it('runs a WebAuthn step-up ceremony and sends the resulting stepUpToken with an unscoped mint', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/webauthn/verify') {
        return Promise.resolve({ stepUpToken: STEP_UP_TOKEN });
      }
      if (url === '/api/auth/mcp-tokens') {
        return Promise.resolve({ id: 'token-new', name: 'My New Token', token: 'mcp_raw', createdAt: '2026-01-01T00:00:00Z', lastUsed: null, driveScopes: [] });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    await renderView([]);

    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByLabelText('Token Name'), 'My New Token');
    await userEvent.click(within(dialog).getByRole('button', { name: /^create token$/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/auth/mcp-tokens', { name: 'My New Token', stepUpToken: STEP_UP_TOKEN }),
    );
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/token created/i));
  });

  it('includes the selected drives array (with the stepUpToken) for a scoped mint', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/webauthn/verify') {
        return Promise.resolve({ stepUpToken: STEP_UP_TOKEN });
      }
      if (url === '/api/auth/mcp-tokens') {
        return Promise.resolve({ id: 'token-new', name: 'Scoped Token', token: 'mcp_raw', createdAt: '2026-01-01T00:00:00Z', lastUsed: null, driveScopes: [] });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    await renderView([]);

    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByLabelText('Token Name'), 'Scoped Token');
    await userEvent.click(within(dialog).getByLabelText('Drive One'));
    await userEvent.click(within(dialog).getByRole('button', { name: /^create token$/i }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/auth/mcp-tokens', {
        name: 'Scoped Token',
        stepUpToken: STEP_UP_TOKEN,
        drives: [{ id: DRIVE_ONE.id, role: null, customRoleId: undefined }],
      }),
    );
  });

  it('falls back to a magic link when the user has no passkey, remembers the pending mint, and does not call the mint endpoint', async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error('no_passkey'));
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/magic-link/request') {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    await renderView([]);

    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByLabelText('Token Name'), 'Pending Token');
    await userEvent.click(within(dialog).getByRole('button', { name: /^create token$/i }));

    await waitFor(() => expect(within(dialog).getAllByText(/check your email/i).length).toBeGreaterThan(0));
    expect(postMock).not.toHaveBeenCalledWith('/api/auth/mcp-tokens', expect.anything());
    expect(JSON.parse(sessionStorage.getItem('pagespace:pendingMcpTokenMint') as string)).toMatchObject({
      name: 'Pending Token',
      driveIds: [],
    });
  });

  it('completes a pending mint automatically when a magic-link step-up token comes back in the URL hash', async () => {
    sessionStorage.setItem(
      'pagespace:pendingMcpTokenMint',
      JSON.stringify({ name: 'Resumed Token', driveIds: [], roleSelections: {} }),
    );
    window.location.hash = '#step_up_token=ps_stepup_from_email';
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/mcp-tokens') {
        return Promise.resolve({ id: 'token-resumed', name: 'Resumed Token', token: 'mcp_raw', createdAt: '2026-01-01T00:00:00Z', lastUsed: null, driveScopes: [] });
      }
      throw new Error(`unexpected post to ${url}`);
    });

    await renderView([]);

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/auth/mcp-tokens', {
        name: 'Resumed Token',
        stepUpToken: 'ps_stepup_from_email',
      }),
    );
    expect(sessionStorage.getItem('pagespace:pendingMcpTokenMint')).toBeNull();
  });

  it('does not start a second step-up ceremony when Enter is pressed again while one is already in flight', async () => {
    let resolveOptions!: (value: { options: { challenge: string }; challengeId: string }) => void;
    const optionsPromise = new Promise<{ options: { challenge: string }; challengeId: string }>((resolve) => {
      resolveOptions = resolve;
    });
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') return optionsPromise;
      throw new Error(`unexpected post to ${url}`);
    });
    await renderView([]);

    const dialog = await openCreateDialog();
    const nameInput = within(dialog).getByLabelText('Token Name');
    await userEvent.type(nameInput, 'My New Token');

    // First Enter starts the ceremony; it hangs on the unresolved options call.
    await userEvent.type(nameInput, '{Enter}');
    // A second Enter while that ceremony is still in flight must be a no-op,
    // not start a second concurrent WebAuthn ceremony/mint request.
    await userEvent.type(nameInput, '{Enter}');

    expect(postMock).toHaveBeenCalledTimes(1);

    resolveOptions({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1));
  });

  it('does not leave the dialog stuck on "Confirming…" after a generic WebAuthn ceremony cancellation, and retries a fresh ceremony on the next click', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError: user cancelled'));
    await renderView([]);

    const dialog = await openCreateDialog();
    await userEvent.type(within(dialog).getByLabelText('Token Name'), 'My New Token');
    await userEvent.click(within(dialog).getByRole('button', { name: /^create token$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /confirming/i })).not.toBeInTheDocument();
    const createButton = within(dialog).getByRole('button', { name: /^create token$/i });
    expect(createButton).not.toBeDisabled();
    expect(startAuthentication).toHaveBeenCalledTimes(1);

    // Clicking again must start a genuinely fresh ceremony, not skip it
    // because stale creating/step-up state was left behind.
    await userEvent.click(createButton);
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(2));
  });
});

describe('MCPSettingsView — edit token step-up fallback and resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    window.location.hash = '';
  });

  it('falls back to a magic link when the user has no passkey, remembers the pending update, and does not call PATCH', async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error('no_passkey'));
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/magic-link/request') {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(within(dialog).getAllByText(/check your email/i).length).toBeGreaterThan(0));
    expect(patchMock).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem('pagespace:pendingMcpTokenUpdate') as string)).toMatchObject({
      tokenId: 'token-1',
      driveIds: [DRIVE_ONE.id, DRIVE_TWO.id],
    });
  });

  it('completes a pending update automatically when a magic-link step-up token comes back in the URL hash', async () => {
    sessionStorage.setItem(
      'pagespace:pendingMcpTokenUpdate',
      JSON.stringify({ tokenId: 'token-1', driveIds: [DRIVE_TWO.id], roleSelections: {} }),
    );
    window.location.hash = '#step_up_token=ps_stepup_from_email';
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });

    await renderView();

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-1', {
        drives: [{ id: DRIVE_TWO.id, role: null, customRoleId: undefined }],
        stepUpToken: 'ps_stepup_from_email',
      }),
    );
    expect(sessionStorage.getItem('pagespace:pendingMcpTokenUpdate')).toBeNull();
  });

  it('does not leave the edit dialog stuck on "Confirming…" after a generic WebAuthn ceremony cancellation, and retries a fresh ceremony on the next click', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError: user cancelled'));
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));
    await userEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /confirming/i })).not.toBeInTheDocument();
    const saveButton = within(dialog).getByRole('button', { name: /save changes/i });
    expect(saveButton).not.toBeDisabled();
    expect(patchMock).not.toHaveBeenCalled();
    expect(startAuthentication).toHaveBeenCalledTimes(1);

    await userEvent.click(saveButton);
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(2));
  });

  it('does not start a second step-up ceremony when Save Changes is clicked again while one is already in flight', async () => {
    let resolveOptions!: (value: { options: { challenge: string }; challengeId: string }) => void;
    const optionsPromise = new Promise<{ options: { challenge: string }; challengeId: string }>((resolve) => {
      resolveOptions = resolve;
    });
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') return optionsPromise;
      throw new Error(`unexpected post to ${url}`);
    });
    await renderView();

    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog).getByLabelText('Drive Two'));

    const saveButton = within(dialog).getByRole('button', { name: /save changes/i });
    // First click starts the ceremony; it hangs on the unresolved options call.
    await userEvent.click(saveButton);
    // The button is now disabled and reads "Confirming…" while the ceremony
    // is in flight — a second click here must be a no-op, mirroring the
    // createToken double-Enter test's assertion that only one request fires.
    await userEvent.click(within(dialog).getByRole('button', { name: /confirming/i }));

    expect(postMock).toHaveBeenCalledTimes(1);

    resolveOptions({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
    await waitFor(() => expect(startAuthentication).toHaveBeenCalledTimes(1));
    expect(patchMock).not.toHaveBeenCalled();
  });
});

describe('MCPSettingsView — Quick MCP Setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const getConfigJson = () => {
    const pre = screen.getByText(/mcpServers/).closest('pre') as HTMLElement;
    return JSON.parse(pre.textContent || '{}');
  };

  it('defaults to the Global install tab with the install step and a "pagespace mcp" config', async () => {
    await renderView();

    expect(screen.getByRole('tab', { name: /global install/i })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('1. Install the pagespace CLI')).toBeInTheDocument();
    expect(screen.getByText('npm install -g @pagespace/cli')).toBeInTheDocument();

    const config = getConfigJson();
    expect(config.mcpServers.pagespace.command).toBe('pagespace');
    expect(config.mcpServers.pagespace.args).toEqual(['mcp']);
    expect(config.mcpServers.pagespace.env).toEqual({
      PAGESPACE_API_URL: 'https://pagespace.ai',
      PAGESPACE_TOKEN: '<YOUR_PAGESPACE_MCP_TOKEN_HERE>',
    });
  });

  it('steers agent MCP setup toward `tokens create --save-as-profile agent`, not `pagespace login`, on the Global install tab', async () => {
    await renderView();

    const setupCard = screen.getByText('Quick MCP Setup').closest('[data-slot="card"]') as HTMLElement;
    expect(within(setupCard).getByText(/pagespace login/)).toBeInTheDocument();
    expect(within(setupCard).getByText(/tokens create --drive/)).toBeInTheDocument();
    expect(within(setupCard).getByText('PAGESPACE_TOKEN', { selector: 'code' })).toBeInTheDocument();
    expect(within(setupCard).getByText(/PAGESPACE_PROFILE/)).toBeInTheDocument();
    expect(within(setupCard).getByText(/reuse that scoped credential/i)).toBeInTheDocument();
  });

  it('switching to the No install (npx) tab hides the install step and emits an npx config', async () => {
    await renderView();

    await userEvent.click(screen.getByRole('tab', { name: /no install \(npx\)/i }));

    expect(screen.queryByText('1. Install the pagespace CLI')).not.toBeInTheDocument();
    expect(screen.queryByText('npm install -g @pagespace/cli')).not.toBeInTheDocument();

    const config = getConfigJson();
    expect(config.mcpServers.pagespace.command).toBe('npx');
    expect(config.mcpServers.pagespace.args).toEqual(['-y', '@pagespace/cli', 'pagespace-mcp']);
    expect(config.mcpServers.pagespace.env).toEqual({
      PAGESPACE_API_URL: 'https://pagespace.ai',
      PAGESPACE_TOKEN: '<YOUR_PAGESPACE_MCP_TOKEN_HERE>',
    });
  });

  it('keeps the token selector and copy/download controls available on both tabs', async () => {
    await renderView();

    expect(screen.getByLabelText(/select token/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /no install \(npx\)/i }));

    expect(screen.getByLabelText(/select token/i)).toBeInTheDocument();
    expect(screen.getByText(/2\. Copy this configuration/)).toBeInTheDocument();
  });
});
