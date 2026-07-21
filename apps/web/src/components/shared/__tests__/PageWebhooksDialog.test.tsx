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
import { useAuthStore } from '@/stores/useAuthStore';
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

/** Click a row's "Rotate secret", then confirm in the alert dialog. */
const confirmRotation = async () => {
  await userEvent.click(await screen.findByRole('button', { name: /^Rotate$/ }));
};
const startRotation = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Rotate secret/ }));
  await confirmRotation();
};

const renderDialog = (pageType = 'AI_CHAT') =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PageWebhooksDialog open onOpenChange={() => {}} pageId={PAGE_ID} pageType={pageType} />
    </SWRConfig>,
  );

describe('PageWebhooksDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ user: { id: 'user-a' } as never });
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

  test('rotation is gated behind an explicit confirmation that names the consequence', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_confirmed',
    });

    renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    await userEvent.click(screen.getByRole('button', { name: /Rotate secret/ }));

    const postedBeforeConfirm = vi.mocked(post).mock.calls.length;
    const warning = await screen.findByText(/current secret stops working immediately/i);

    await confirmRotation();
    await waitFor(() => screen.getByText('whsec_confirmed'));

    assert({
      given: 'a click on Rotate secret',
      should: 'not call the API until the destructive consequence is confirmed',
      actual: {
        postedBeforeConfirm,
        warningShown: warning !== null,
        postedAfterConfirm: vi.mocked(post).mock.calls.length,
      },
      expected: { postedBeforeConfirm: 0, warningShown: true, postedAfterConfirm: 1 },
    });
  });

  test('a second rotation of the same webhook is refused while one is in flight across remounts', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    const resolvers: Array<(value: unknown) => void> = [];
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvers.push(resolve as (value: unknown) => void); }),
    );

    const first = renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();
    first.unmount();

    const second = renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();

    const postsAfterRefusal = vi.mocked(post).mock.calls.length;
    const refusalToast = vi.mocked(toast.error).mock.calls[0]?.[0];

    resolvers[0]({ webhook: remoteWebhook(), webhookSecret: 'whsec_serialized' });
    await waitFor(() => screen.getByText('whsec_serialized'));
    second.unmount();

    assert({
      given: 'a rotation still in flight from a previous mount of this dialog',
      should: 'refuse a second rotation of the same webhook (commit order is unknowable) and deliver the in-flight secret',
      actual: {
        postsAfterRefusal,
        refusalMentionsProgress: typeof refusalToast === 'string' && /in progress/i.test(refusalToast),
        inFlightSecretDelivered: true,
      },
      expected: { postsAfterRefusal: 1, refusalMentionsProgress: true, inFlightSecretDelivered: true },
    });
  });

  test('toggling or deleting another row does not unlock secret-producing actions mid-rotation', async () => {
    const second = { ...remoteWebhook(), id: 'wh-2', name: 'Alerts', webhookToken: 'tok_second_999999' };
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      listResponse(200, { webhooks: [remoteWebhook(), second] }),
    );
    let resolveRotation: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolveRotation = resolve as (value: unknown) => void; }),
    );
    const { del } = await import('@/lib/auth/auth-fetch');
    vi.mocked(del).mockResolvedValue(undefined);

    renderDialog();
    await waitFor(() => screen.getByText('Alerts'));

    const rotateButtons = screen.getAllByRole('button', { name: /Rotate secret/ });
    await userEvent.click(rotateButtons[0]);
    await confirmRotation();

    // Delete the OTHER row while the rotation is still pending — its finally
    // must not unlock the mint gate.
    await userEvent.click(screen.getAllByRole('button', { name: /^Delete$/ })[1]);
    await new Promise((r) => { setTimeout(r, 0); });

    assert({
      given: 'a delete on another row settling while a rotation is still in flight',
      should: 'keep every secret-producing action locked until the rotation settles',
      actual: {
        otherRotateDisabled: (screen.getAllByRole('button', { name: /Rotate secret/ })[1] as HTMLButtonElement).disabled,
        createDisabled: (screen.getByRole('button', { name: /Create webhook/ }) as HTMLButtonElement).disabled,
      },
      expected: { otherRotateDisabled: true, createDisabled: true },
    });

    resolveRotation({ webhook: remoteWebhook(), webhookSecret: 'whsec_settled_late' });
  });

  test('two secrets parked while unmounted are both delivered, one reveal at a time', async () => {
    const secondHook = { ...remoteWebhook(), id: 'wh-2', name: 'Alerts', webhookToken: 'tok_second_999999' };
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      listResponse(200, { webhooks: [remoteWebhook(), secondHook] }),
    );
    const resolvers: Array<(value: unknown) => void> = [];
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvers.push(resolve as (value: unknown) => void); }),
    );

    const first = renderDialog();
    await waitFor(() => screen.getByText('Alerts'));
    const rotateButtons = screen.getAllByRole('button', { name: /Rotate secret/ });
    await userEvent.click(rotateButtons[0]);
    await confirmRotation();
    first.unmount();

    const second = renderDialog();
    await waitFor(() => screen.getByText('Alerts'));
    await userEvent.click(screen.getAllByRole('button', { name: /Rotate secret/ })[1]);
    await confirmRotation();
    second.unmount();

    resolvers[0]({ webhook: remoteWebhook(), webhookSecret: 'whsec_first_parked' });
    resolvers[1]({ webhook: secondHook, webhookSecret: 'whsec_second_parked' });
    await new Promise((r) => { setTimeout(r, 0); });

    renderDialog();
    const firstShown = await screen.findByText('whsec_first_parked');
    await userEvent.click(screen.getByRole('button', { name: /Done, I've saved it/ }));
    const secondShown = await screen.findByText('whsec_second_parked');

    assert({
      given: 'two rotations of different webhooks whose responses both landed while unmounted',
      should: 'deliver both parked one-time secrets in order, one reveal at a time',
      actual: { firstShown: firstShown !== null, secondShown: secondShown !== null },
      expected: { firstShown: true, secondShown: true },
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

    await startRotation();
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

    await startRotation();
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

    await startRotation();
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
    await confirmRotation();
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

  test('a rotation resolving after the dialog closes still reveals its secret on reopen', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    let resolvePost: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvePost = resolve as (value: unknown) => void; }),
    );

    const dialogAt = (open: boolean) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PageWebhooksDialog open={open} onOpenChange={() => {}} pageId={PAGE_ID} pageType="AI_CHAT" />
      </SWRConfig>
    );
    const view = render(dialogAt(true));
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();

    view.rerender(dialogAt(false));
    resolvePost({ webhook: remoteWebhook(), webhookSecret: 'whsec_late_arrival' });
    // The response must be fully processed while the dialog is still closed —
    // reopening first would mask a wipe of the closed-dialog reveal.
    await new Promise((r) => { setTimeout(r, 0); });
    view.rerender(dialogAt(true));
    await waitFor(() => screen.getByText('whsec_late_arrival'));

    assert({
      given: 'a rotation whose response arrived only after the dialog was closed',
      should: 'reveal the one-time secret on reopen — the old secret is already dead and this is the only copy',
      actual: screen.getByText('whsec_late_arrival') !== null,
      expected: true,
    });
  });

  test('a rotation resolving after the component unmounts reveals on the next mount', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    let resolvePost: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvePost = resolve as (value: unknown) => void; }),
    );

    const first = renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();
    first.unmount();

    resolvePost({ webhook: remoteWebhook(), webhookSecret: 'whsec_after_unmount' });
    await new Promise((r) => { setTimeout(r, 0); });

    renderDialog();
    await waitFor(() => screen.getByText('whsec_after_unmount'));

    assert({
      given: 'a rotation whose response landed after the page-scoped component unmounted (navigation)',
      should: 'hold the one-time secret and reveal it on the next mount of this page’s dialog',
      actual: screen.getByText('whsec_after_unmount') !== null,
      expected: true,
    });
  });

  test('a rotation from one page never reveals in another page’s dialog', async () => {
    vi.mocked(fetchWithAuth).mockResolvedValue(
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    let resolvePost: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvePost = resolve as (value: unknown) => void; }),
    );

    const dialogFor = (pid: string) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PageWebhooksDialog open onOpenChange={() => {}} pageId={pid} pageType="CHANNEL" />
      </SWRConfig>
    );
    const view = render(dialogFor(PAGE_ID));
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();

    // Same component instance survives navigation (CenterPanel reuses the
    // view across channel ids) — only the pageId prop changes.
    view.rerender(dialogFor('page-2'));
    resolvePost({ webhook: remoteWebhook(), webhookSecret: 'whsec_page_scoped' });
    await new Promise((r) => { setTimeout(r, 0); });

    const leakedIntoOtherPage = screen.queryByText('whsec_page_scoped');

    view.rerender(dialogFor(PAGE_ID));
    await waitFor(() => screen.getByText('whsec_page_scoped'));

    assert({
      given: 'a rotation started on page A whose response landed while the same dialog instance showed page B',
      should: 'never reveal A’s secret in B’s dialog, but deliver it when A’s dialog is shown again',
      actual: {
        leakedIntoOtherPage,
        revealedOnOwnPage: screen.getByText('whsec_page_scoped') !== null,
      },
      expected: { leakedIntoOtherPage: null, revealedOnOwnPage: true },
    });
  });

  test('closing without acknowledging parks the on-screen secret; acknowledging discards it', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_unacknowledged',
    });

    const dialogAt = (open: boolean) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PageWebhooksDialog open={open} onOpenChange={() => {}} pageId={PAGE_ID} pageType="AI_CHAT" />
      </SWRConfig>
    );
    const view = render(dialogAt(true));
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();
    await waitFor(() => screen.getByText('whsec_unacknowledged'));

    // Accidental close (X / Escape / outside click / generic Done) — the
    // unacknowledged secret must come back on reopen.
    view.rerender(dialogAt(false));
    await new Promise((r) => { setTimeout(r, 0); });
    view.rerender(dialogAt(true));
    const survivedClose = await screen.findByText('whsec_unacknowledged');

    // Explicit acknowledgement is the one true discard.
    await userEvent.click(screen.getByRole('button', { name: /Done, I've saved it/ }));
    view.rerender(dialogAt(false));
    await new Promise((r) => { setTimeout(r, 0); });
    view.rerender(dialogAt(true));
    await waitFor(() => screen.getByText('Deploys'));

    assert({
      given: 'a revealed secret across an unacknowledged close and then an acknowledged one',
      should: 'redeliver after the accidental close and stay gone after "Done, I\'ve saved it"',
      actual: {
        survivedClose: survivedClose !== null,
        goneAfterAck: screen.queryByText('whsec_unacknowledged'),
      },
      expected: { survivedClose: true, goneAfterAck: null },
    });
  });

  test('the reveal panel outranks a failed list refresh', async () => {
    vi.mocked(fetchWithAuth)
      .mockResolvedValueOnce(listResponse(200, { webhooks: [remoteWebhook()] }))
      .mockImplementation(async () => listResponse(500, { error: 'transient list failure' }));
    vi.mocked(post).mockResolvedValue({
      webhook: remoteWebhook(),
      webhookSecret: 'whsec_outranks_errors',
    });

    renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();
    await waitFor(() => screen.getByText('whsec_outranks_errors'));

    assert({
      given: 'a successful rotation whose follow-up list refresh resolves to a non-2xx error state',
      should: 'render the one-time secret panel, never the list error screen, over the only copy',
      actual: {
        secret: screen.getByText('whsec_outranks_errors') !== null,
        errorScreen: screen.queryByText('Failed to load webhooks.'),
      },
      expected: { secret: true, errorScreen: null },
    });
  });

  test('a parked secret is never delivered to a different authenticated user', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      listResponse(200, { webhooks: [remoteWebhook()] }),
    );
    let resolvePost: (value: unknown) => void = () => {};
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvePost = resolve as (value: unknown) => void; }),
    );

    const first = renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    await startRotation();
    first.unmount();

    resolvePost({ webhook: remoteWebhook(), webhookSecret: 'whsec_user_scoped' });
    await new Promise((r) => { setTimeout(r, 0); });

    // A different account on the same shared browser opens the same page's dialog.
    useAuthStore.setState({ user: { id: 'user-b' } as never });
    const second = renderDialog();
    await waitFor(() => screen.getByText('Deploys'));
    const leakedToOtherUser = screen.queryByText('whsec_user_scoped');
    second.unmount();

    // The owner comes back — their secret is still deliverable.
    useAuthStore.setState({ user: { id: 'user-a' } as never });
    renderDialog();
    const deliveredToOwner = await screen.findByText('whsec_user_scoped');

    assert({
      given: 'a parked one-time secret and a subsequent sign-in by a different user',
      should: 'never deliver the parked secret to another account, but keep it for its owner',
      actual: {
        leakedToOtherUser,
        deliveredToOwner: deliveredToOwner !== null,
      },
      expected: { leakedToOtherUser: null, deliveredToOwner: true },
    });
  });

  test('a second resolving mint queues behind an on-screen secret instead of overwriting it', async () => {
    const hookB = { ...remoteWebhook(), id: 'wh-2', name: 'Alerts', webhookToken: 'tok_second_999999' };
    vi.mocked(fetchWithAuth).mockImplementation(async () =>
      listResponse(200, { webhooks: [remoteWebhook(), hookB] }),
    );
    const resolvers: Array<(value: unknown) => void> = [];
    vi.mocked(post).mockImplementation(
      () => new Promise<never>((resolve) => { resolvers.push(resolve as (value: unknown) => void); }),
    );

    const first = renderDialog();
    await waitFor(() => screen.getByText('Alerts'));
    await userEvent.click(screen.getAllByRole('button', { name: /Rotate secret/ })[0]);
    await confirmRotation();
    first.unmount();

    // Fresh instance after navigation: its mint gate is clear, so rotating B
    // is allowed while A is still in flight from the previous mount.
    renderDialog();
    await waitFor(() => screen.getByText('Alerts'));
    await userEvent.click(screen.getAllByRole('button', { name: /Rotate secret/ })[1]);
    await confirmRotation();

    resolvers[0]({ webhook: remoteWebhook(), webhookSecret: 'whsec_A_shown_first' });
    await waitFor(() => screen.getByText('whsec_A_shown_first'));
    resolvers[1]({ webhook: hookB, webhookSecret: 'whsec_B_queued' });
    await new Promise((r) => { setTimeout(r, 0); });

    const aStillShown = screen.queryByText('whsec_A_shown_first');
    await userEvent.click(screen.getByRole('button', { name: /Done, I've saved it/ }));
    const bShownNext = await screen.findByText('whsec_B_queued');

    assert({
      given: 'a second mint resolving while another one-time secret is on screen',
      should: 'keep the on-screen secret and queue the new one for the next reveal slot',
      actual: { aStillShown: aStillShown !== null, bShownNext: bShownNext !== null },
      expected: { aStillShown: true, bShownNext: true },
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
