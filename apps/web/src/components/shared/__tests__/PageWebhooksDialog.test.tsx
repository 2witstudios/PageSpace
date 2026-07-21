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

import { toast } from 'sonner';
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

const renderDialog = (pageType = 'AI_CHAT') =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PageWebhooksDialog open onOpenChange={() => {}} pageId={PAGE_ID} pageType={pageType} />
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

  test('description copy states the channel default action only on channels', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(listResponse(200, { webhooks: [] }));

    const channelRender = renderDialog('CHANNEL');
    await waitFor(() => screen.getByText(/post messages into this channel/));
    const channelCopyShown = screen.getByText(/post messages into this channel/) !== null;
    channelRender.unmount();

    renderDialog('AI_CHAT');
    await waitFor(() => screen.getByText(/push events to this page/));

    assert({
      given: 'the dialog mounted on a CHANNEL page and then on an AI_CHAT page',
      should: 'describe the post-as-messages default only for the channel, neutral copy elsewhere',
      actual: {
        channelCopyShown,
        aiPageNeutralCopy: screen.getByText(/push events to this page/) !== null,
        aiPageChannelCopy: screen.queryByText(/post messages into this channel/),
      },
      expected: { channelCopyShown: true, aiPageNeutralCopy: true, aiPageChannelCopy: null },
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

  test('rotates a webhook secret in place and reveals the new secret exactly once', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_rotated_once',
    });

    renderDialog();
    await waitFor(() => screen.getByText('Deploys'));

    await userEvent.click(screen.getByRole('button', { name: /Rotate secret/ }));
    await waitFor(() => screen.getByText('whsec_rotated_once'));

    assert({
      given: 'the user rotated an existing webhook secret',
      should: 'POST to the rotate endpoint and show the new secret once, same URL',
      actual: {
        endpoint: vi.mocked(post).mock.calls[0]?.[0],
        secret: screen.getByText('whsec_rotated_once') !== null,
        sameUrl: screen.getByText(new RegExp('/api/webhooks/tok_abcdef12345678')) !== null,
        dismiss: screen.getByRole('button', { name: /Done, I've saved it/ }) !== null,
      },
      expected: {
        endpoint: `/api/pages/${PAGE_ID}/webhooks/wh-1/rotate`,
        secret: true,
        sameUrl: true,
        dismiss: true,
      },
    });
  });

  test('surfaces the server explanation when rotation fails (e.g. concurrent rotation)', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    const conflict =
      'The secret was rotated by a concurrent request — use that rotation’s secret or rotate again';
    vi.mocked(post).mockRejectedValue(new Error(conflict));

    renderDialog();
    await waitFor(() => screen.getByText('Deploys'));

    await userEvent.click(screen.getByRole('button', { name: /Rotate secret/ }));
    await waitFor(() => {
      if (vi.mocked(toast.error).mock.calls.length === 0) throw new Error('no toast yet');
    });

    assert({
      given: 'the rotate request failed with a server-provided reason',
      should: 'surface that reason in the error toast and never show a secret panel',
      actual: {
        toastMessage: vi.mocked(toast.error).mock.calls[0]?.[0],
        revealPanel: screen.queryByText(/Save this secret now/),
      },
      expected: { toastMessage: conflict, revealPanel: null },
    });
  });

  test('reveals the rotated secret even when the list refresh fails', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(listResponse(200, { webhooks: [remoteWebhook()] }))
      .mockRejectedValue(new Error('network down'));
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_survives_refetch',
    });

    renderDialog();
    await waitFor(() => screen.getByText('Deploys'));

    await userEvent.click(screen.getByRole('button', { name: /Rotate secret/ }));
    await waitFor(() => screen.getByText('whsec_survives_refetch'));

    assert({
      given: 'a successful rotation whose follow-up list revalidation rejects',
      should: 'still reveal the one-time secret (the old one is already dead) with no error toast',
      actual: {
        secret: screen.getByText('whsec_survives_refetch') !== null,
        errorToasts: vi.mocked(toast.error).mock.calls.length,
      },
      expected: { secret: true, errorToasts: 0 },
    });
  });

  test('reveals the created secret even when the list refresh fails', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(listResponse(200, { webhooks: [] }))
      .mockRejectedValue(new Error('network down'));
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_created_survives',
    });

    renderDialog();
    await waitFor(() => screen.getByPlaceholderText(/Webhook name/));

    await userEvent.type(screen.getByPlaceholderText(/Webhook name/), 'Deploys');
    await userEvent.click(screen.getByRole('button', { name: /Create webhook/ }));
    await waitFor(() => screen.getByText('whsec_created_survives'));

    assert({
      given: 'a successful creation whose follow-up list revalidation rejects',
      should: 'still reveal the one-time secret with no error toast',
      actual: {
        secret: screen.getByText('whsec_created_survives') !== null,
        errorToasts: vi.mocked(toast.error).mock.calls.length,
      },
      expected: { secret: true, errorToasts: 0 },
    });
  });

  test('a pending rotation disables every other secret-producing action', async () => {
    const second = { ...remoteWebhook(), id: 'wh-2', name: 'Alerts', webhookToken: 'tok_second_999999' };
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook(), second] }),
    );
    let resolvePost: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvePost = resolve as (value: unknown) => void; }),
    );

    renderDialog();
    await waitFor(() => screen.getByText('Alerts'));

    const rotateButtons = screen.getAllByRole('button', { name: /Rotate secret/ });
    await userEvent.click(rotateButtons[0]);
    await waitFor(() => {
      if (!(rotateButtons[1] as HTMLButtonElement).disabled) throw new Error('not yet disabled');
    });

    assert({
      given: 'a rotation in flight on one webhook of several',
      should: 'disable the other rotate and create actions so a second one-time secret cannot overwrite the first reveal',
      actual: {
        otherRotateDisabled: (rotateButtons[1] as HTMLButtonElement).disabled,
        createDisabled: (screen.getByRole('button', { name: /Create webhook/ }) as HTMLButtonElement).disabled,
      },
      expected: { otherRotateDisabled: true, createDisabled: true },
    });

    resolvePost({ webhook: remoteWebhook(), webhookSecret: 'whsec_settled' });
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
