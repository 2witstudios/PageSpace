// @vitest-environment jsdom
import { createElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { SWRConfig } from 'swr';
import { click, mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { PageWebhooksDialog } from './PageWebhooksDialog';

type Listing = { webhooks: unknown[] } | { error: string; status: number };

const fixtures = vi.hoisted(() => ({
  listing: { webhooks: [] } as Listing,
  created: null as null | { webhook: unknown; webhookSecret: string },
  rotated: null as null | { webhook: unknown; webhookSecret: string },
}));

const spies = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: spies.fetchWithAuth,
  post: spies.post,
  patch: spies.patch,
  del: spies.del,
}));
vi.mock('@/retained/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: 'me' } }),
}));
vi.mock('sonner', () => ({ toast: { success: spies.toastSuccess, error: spies.toastError } }));

// Radix's switch measures itself with ResizeObserver, which jsdom does not ship.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const hook = (overrides: Record<string, unknown> = {}) => ({
  id: 'w1',
  name: 'Deploys',
  webhookToken: 'tok-abcdefgh',
  isEnabled: true,
  lastFiredAt: null,
  lastFireError: 'HTTP 401 — signature did not match',
  ...overrides,
});

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Lets SWR resolve and React flush, then runs the check. */
const settle = async (check: () => void): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  check();
};

const open = () =>
  mount(
    createElement(
      SWRConfig,
      { value: { provider: () => new Map(), dedupingInterval: 0 } },
      createElement(PageWebhooksDialog, { open: true, onOpenChange: () => {}, pageId: 'c1', pageType: 'CHANNEL' }),
    ),
  );

const buttonNamed = (name: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  );

const bodyText = () => document.body.textContent ?? '';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  fixtures.listing = { webhooks: [] };
  fixtures.created = null;
  fixtures.rotated = null;
  spies.fetchWithAuth.mockImplementation(async () => respond(fixtures.listing, 'error' in fixtures.listing ? fixtures.listing.status : 200));
  spies.post.mockImplementation(async (url: string) => {
    if (url.endsWith('/rotate')) return fixtures.rotated;
    return fixtures.created;
  });
  spies.patch.mockResolvedValue({});
  spies.del.mockResolvedValue({});
});

afterEach(() => {
  unmountAll();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('PageWebhooksDialog', () => {
  test('lists each webhook with its token tail, last failed delivery, switch, Rotate secret and Delete', async () => {
    fixtures.listing = { webhooks: [hook()] };
    open();
    await settle(() => {
      assert({
        given: 'one enabled webhook whose last delivery failed',
        should: 'show its name, token tail, error line and the labelled switch, Rotate and Delete controls',
        actual: {
          name: bodyText().includes('Deploys'),
          tail: bodyText().includes('…abcdefgh'),
          error: bodyText().includes('Last delivery failed: HTTP 401 — signature did not match'),
          switchLabel: document.querySelector('[role="switch"]')?.getAttribute('aria-label') ?? null,
          rotate: buttonNamed('Rotate secret') !== undefined,
          deleteLabel: buttonNamed('Delete Deploys') !== undefined,
        },
        expected: {
          name: true,
          tail: true,
          error: true,
          switchLabel: 'Disable Deploys',
          rotate: true,
          deleteLabel: true,
        },
      });
    });
  });

  test('shows the empty-state copy when there are no webhooks', async () => {
    open();
    await settle(() => {
      assert({
        given: 'a channel with no webhooks',
        should: 'explain what a webhook is for in the empty state',
        actual: bodyText().includes(
          "No webhooks yet — create one to let an external system (CI, monitoring, a script) send events to this page.",
        ),
        expected: true,
      });
    });
  });

  test('hides creation for a non-admin, whose list request answers 403', async () => {
    fixtures.listing = { error: 'Forbidden', status: 403 };
    open();
    await settle(() => {
      assert({
        given: 'a viewer who is neither owner nor admin (the list answers 403)',
        should: 'show the owner/admin notice and no Create webhook button',
        actual: {
          notice: bodyText().includes("Only this drive's owner or an admin can manage webhooks."),
          create: buttonNamed('Create webhook') ?? null,
        },
        expected: { notice: true, create: null },
      });
    });
  });

  test('reveals the URL and secret once after create, and returns to the list on Done', async () => {
    fixtures.created = {
      webhook: hook({ id: 'w2', name: 'CI', webhookToken: 'tok-newtoken1' }),
      webhookSecret: 'secret-once-123',
    };
    const container = open();
    await settle(() => {});
    const input = container.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="Webhook name"]');
    if (input) typeInto(input, 'CI');
    const create = buttonNamed('Create webhook');
    if (create) click(create);
    await settle(() => {
      assert({
        given: 'a new webhook was created',
        should: 'show the save-now copy, the URL and secret, Copy and Done, I\'ve saved it',
        actual: {
          save: bodyText().includes("Save this secret now — it won't be shown again."),
          url: bodyText().includes(`${window.location.origin}/api/webhooks/tok-newtoken1`),
          secret: bodyText().includes('secret-once-123'),
          copy: buttonNamed('Copy') !== undefined,
          done: buttonNamed("Done, I've saved it") !== undefined,
        },
        expected: { save: true, url: true, secret: true, copy: true, done: true },
      });
    });
    const done = buttonNamed("Done, I've saved it");
    if (done) click(done);
    await settle(() => {
      assert({
        given: 'the viewer acknowledges the one-time secret',
        should: 'drop the reveal and show the webhook list again',
        actual: { secret: bodyText().includes('secret-once-123'), list: buttonNamed('Rotate secret') !== undefined || bodyText().includes('No webhooks yet') },
        expected: { secret: false, list: true },
      });
    });
  });

  test('confirms before rotating and reveals the new secret once', async () => {
    fixtures.listing = { webhooks: [hook()] };
    fixtures.rotated = { webhook: hook(), webhookSecret: 'rotated-secret-456' };
    open();
    await settle(() => {});
    const rotate = buttonNamed('Rotate secret');
    if (rotate) click(rotate);
    await settle(() => {
      assert({
        given: 'Rotate secret was pressed',
        should: 'ask "Rotate this webhook\'s secret?" before anything changes',
        actual: { confirm: bodyText().includes("Rotate this webhook's secret?"), posted: spies.post.mock.calls.length },
        expected: { confirm: true, posted: 0 },
      });
    });
    const confirm = buttonNamed('Rotate');
    if (confirm) click(confirm);
    await settle(() => {
      assert({
        given: 'the rotation is confirmed',
        should: 'call the rotate route and reveal the new secret',
        actual: {
          url: spies.post.mock.calls[0]?.[0] ?? null,
          secret: bodyText().includes('rotated-secret-456'),
        },
        expected: { url: '/api/pages/c1/webhooks/w1/rotate', secret: true },
      });
    });
  });

  test('copies the URL and secret and confirms with a toast', async () => {
    fixtures.created = { webhook: hook({ id: 'w2', webhookToken: 'tok-copy' }), webhookSecret: 'copy-secret-789' };
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const container = open();
    await settle(() => {});
    const input = container.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="Webhook name"]');
    if (input) typeInto(input, 'Copy me');
    const create = buttonNamed('Create webhook');
    if (create) click(create);
    await settle(() => {});
    const copy = buttonNamed('Copy');
    if (copy) click(copy);
    await settle(() => {
      assert({
        given: 'the revealed URL and secret',
        should: 'copy both to the clipboard and confirm with "Copied to clipboard"',
        actual: { wrote: writeText.mock.calls[0]?.[0] ?? null, toast: spies.toastSuccess.mock.calls[0]?.[0] ?? null },
        expected: {
          wrote: `${window.location.origin}/api/webhooks/tok-copy\ncopy-secret-789`,
          toast: 'Copied to clipboard',
        },
      });
    });
  });
});
