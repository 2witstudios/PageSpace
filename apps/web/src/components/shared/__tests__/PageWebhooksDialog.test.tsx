import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { assert } from '@/stores/__tests__/riteway';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { PageWebhooksDialog } from '../PageWebhooksDialog';

const PAGE_ID = 'page-1';

const remoteWebhook = () => ({
  id: 'wh-1',
  name: 'Deploys',
  webhookToken: 'tok_abcdef12345678',
  isEnabled: true,
  lastFiredAt: null,
  lastFireError: null,
});

const listResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const renderDialog = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PageWebhooksDialog open onOpenChange={() => {}} pageId={PAGE_ID} />
    </SWRConfig>,
  );

describe('PageWebhooksDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('lists webhooks under the Incoming Webhooks title', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );

    renderDialog();
    await waitFor(() => screen.getByText('Deploys'));

    assert({
      given: 'an open dialog whose webhook list loads successfully',
      should: 'render the page-agnostic "Incoming Webhooks" title and the webhook row',
      actual: {
        title: screen.getByText('Incoming Webhooks') !== null,
        row: screen.getByText('Deploys') !== null,
      },
      expected: { title: true, row: true },
    });
  });

  test('shows the owner/admin explanation on a 403 — disabled, not hidden', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(403, { error: 'Forbidden' }),
    );

    renderDialog();
    await waitFor(() =>
      screen.getByText(/Only this drive's owner or an admin can manage webhooks/),
    );

    assert({
      given: 'a viewer without owner/admin rights (webhook list returns 403)',
      should: 'explain the permission requirement instead of rendering the create form',
      actual: {
        explanation:
          screen.getByText(/Only this drive's owner or an admin can manage webhooks/) !== null,
        createForm: screen.queryByPlaceholderText(/Webhook name/),
      },
      expected: { explanation: true, createForm: null },
    });
  });

  test('distinguishes a server failure from missing permission', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(500, { error: 'Failed to list webhooks' }),
    );

    renderDialog();
    await waitFor(() => screen.getByText('Failed to load webhooks.'));

    assert({
      given: 'the webhook list request fails with a non-403 error',
      should: 'show a retryable failure message, NOT the owner/admin explanation',
      actual: {
        failure: screen.getByText('Failed to load webhooks.') !== null,
        retry: screen.getByRole('button', { name: /Retry/ }) !== null,
        permissionCopy: screen.queryByText(/Only this drive's owner or an admin/),
      },
      expected: { failure: true, retry: true, permissionCopy: null },
    });
  });

  test('reveals the secret exactly once, dismissed only by explicit confirmation', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(listResponse(200, { webhooks: [] }));
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_only_shown_once',
    });

    renderDialog();
    await waitFor(() => screen.getByPlaceholderText(/Webhook name/));

    await userEvent.type(screen.getByPlaceholderText(/Webhook name/), 'Deploys');
    await userEvent.click(screen.getByRole('button', { name: /Create webhook/ }));
    await waitFor(() => screen.getByText('whsec_only_shown_once'));

    assert({
      given: 'a webhook was just created',
      should: 'show the secret with a copy affordance and an explicit dismiss button',
      actual: {
        secret: screen.getByText('whsec_only_shown_once') !== null,
        copy: screen.getByRole('button', { name: /Copy/ }) !== null,
        dismiss: screen.getByRole('button', { name: /Done, I've saved it/ }) !== null,
      },
      expected: { secret: true, copy: true, dismiss: true },
    });

    await userEvent.click(screen.getByRole('button', { name: /Done, I've saved it/ }));

    assert({
      given: 'the user confirmed they saved the secret',
      should: 'remove the secret from the DOM for good',
      actual: screen.queryByText('whsec_only_shown_once'),
      expected: null,
    });
  });
});
