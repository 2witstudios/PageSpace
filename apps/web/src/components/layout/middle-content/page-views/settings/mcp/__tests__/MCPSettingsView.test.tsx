import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
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
  await waitFor(() => expect(screen.getByText('Token A')).toBeInTheDocument());
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
      })
    );

    // Clearing all selections submits an explicit empty array, not an omitted field.
    patchMock.mockResolvedValueOnce({ id: 'token-1', name: 'Token A', driveScopes: [] });
    await userEvent.click(within(getCardFor('Token A')).getByRole('button', { name: /edit token scopes/i }));
    const dialog2 = await screen.findByRole('dialog', { name: /edit token drive scopes/i });
    await userEvent.click(within(dialog2).getByRole('button', { name: /clear selection/i }));
    await userEvent.click(within(dialog2).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/api/auth/mcp-tokens/token-1', { drives: [] })
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
