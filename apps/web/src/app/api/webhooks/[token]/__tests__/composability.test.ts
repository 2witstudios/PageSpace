import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

/**
 * Deep composability proof for the Incoming Webhooks primitive.
 *
 * route.test.ts already proves, at the route-orchestration layer, that
 * `dispatchWebhookDelivery` and `firePageWebhookTriggers` are BOTH invoked for
 * one delivery — but it mocks `firePageWebhookTriggers` away entirely, so it
 * can't tell a real workflow invocation from a stub.
 *
 * This file keeps the CHANNEL default action (`dispatchWebhookDelivery`,
 * `packages/lib`) mocked at the same boundary as route.test.ts — that path
 * already has its own dedicated unit coverage in packages/lib — but lets the
 * ENTIRE trigger fan-out run for real: `firePageWebhookTriggers` ->
 * `executePageWebhookTrigger` -> the drive-match guard, billing/credit gate,
 * and prompt construction all execute as written, mocked only at the true
 * leaves (`executeWorkflow`, permissions, credit gate/consume, rate limit,
 * db). One signed POST to a CHANNEL webhook with an enabled workflow trigger
 * must invoke BOTH the channel handler AND `executeWorkflow` exactly once —
 * proving the two action paths compose instead of being mutually exclusive.
 */

const SECRET = 'test-webhook-secret';
const WEBHOOK = {
  id: 'wh-1',
  pageId: 'page-1',
  name: 'Deploys',
  isEnabled: true,
  webhookToken: 'tok-abc',
  webhookSecretEncrypted: 'encrypted-form-of-secret',
};
const TRIGGER = { id: 'trigger-1', workflowId: 'workflow-1', pageWebhookId: 'wh-1', isEnabled: true };
const WORKFLOW = {
  id: 'workflow-1',
  driveId: 'drive-1',
  createdBy: 'user-1',
  agentPageId: 'agent-page-1',
  prompt: 'Summarize the delivery',
  contextPageIds: [],
  instructionPageId: null,
  timezone: 'UTC',
};

const mockPageWebhookFindFirst = vi.fn();
const mockWebhookTriggersFindMany = vi.fn();

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      pageWebhooks: { findFirst: (...args: unknown[]) => mockPageWebhookFindFirst(...args) },
      webhookTriggers: { findMany: (...args: unknown[]) => mockWebhookTriggersFindMany(...args) },
    },
    // executePageWebhookTrigger walks a fixed sequence of select().from().where()
    // lookups for a single trigger fire: 1) the linked workflow row, 2) the
    // webhook -> pageId, 3) the webhook's page (drive/trashed), 4) the agent
    // page (drive/trashed), 5) the billing owner row. A queue is simpler and
    // just as accurate as matching on table identity for one delivery.
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(selectQueue[selectCallIndex++] ?? []),
      }),
    }),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  },
}));

let selectQueue: unknown[][] = [];
let selectCallIndex = 0;

vi.mock('@pagespace/db/operators', () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  and: (...conds: unknown[]) => ({ and: conds }),
}));
vi.mock('@pagespace/db/schema/page-webhooks', () => ({
  pageWebhooks: { id: 'pageWebhooks.id', webhookToken: 'pageWebhooks.webhookToken', pageId: 'pageWebhooks.pageId' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'pages.id', driveId: 'pages.driveId', isTrashed: 'pages.isTrashed' },
}));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'workflows.id' } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'users.id', subscriptionTier: 'users.subscriptionTier' } }));
vi.mock('@pagespace/db/schema/webhook-triggers', () => ({
  webhookTriggers: {
    id: 'webhookTriggers.id',
    pageWebhookId: 'webhookTriggers.pageWebhookId',
    isEnabled: 'webhookTriggers.isEnabled',
  },
}));

vi.mock('@pagespace/lib/encryption/field-crypto', () => ({
  decryptField: vi.fn(async (v: string) => (v === WEBHOOK.webhookSecretEncrypted ? SECRET : v)),
}));

// The CHANNEL default action — same mocking boundary route.test.ts uses.
// Its real payload-validation/rate-limit/insert logic has dedicated unit
// coverage in packages/lib; this file's job is proving composability, not
// re-testing that logic.
const mockDispatch = vi.fn();
vi.mock('@pagespace/lib/services/page-webhook-dispatch', () => ({
  dispatchWebhookDelivery: (...args: unknown[]) => mockDispatch(...args),
}));

const mockCheckDistributedRateLimit = vi.fn();
vi.mock('@pagespace/lib/security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: (...args: unknown[]) => mockCheckDistributedRateLimit(...args),
  DISTRIBUTED_RATE_LIMITS: { PAGE_WEBHOOK: {}, PAGE_WEBHOOK_TRIGGER: {} },
}));

// Replay idempotency (F4) is mocked as always-first-delivery: this file proves
// trigger fan-out composability, and route.test.ts owns the dedup behavior.
vi.mock('@pagespace/lib/security/webhook-delivery-idempotency', () => ({
  deriveWebhookDeliveryId: () => 'delivery-1',
  claimWebhookDelivery: vi.fn(async () => 'claimed'),
  completeWebhookDelivery: vi.fn(async () => undefined),
  releaseWebhookDelivery: vi.fn(async () => undefined),
}));

const mockIsUserDriveMember = vi.fn();
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  isUserDriveMember: (...args: unknown[]) => mockIsUserDriveMember(...args),
}));

const mockCanConsumeAI = vi.fn();
vi.mock('@pagespace/lib/billing/credit-gate', () => ({
  canConsumeAI: (...args: unknown[]) => mockCanConsumeAI(...args),
}));

const mockReleaseHold = vi.fn();
vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: (...args: unknown[]) => mockReleaseHold(...args),
}));

const mockExecuteWorkflow = vi.fn();
vi.mock('@/lib/workflows/workflow-executor', () => ({
  executeWorkflow: (...args: unknown[]) => mockExecuteWorkflow(...args),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return {
    loggers: {
      api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child },
      system: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child },
    },
  };
});

// `after()` schedules post-response work in real Next.js. The test captures
// the callback instead of firing it inline, so it can explicitly await the
// trigger fan-out after the sender's response — deterministic, no race
// between the HTTP response and the background fan-out.
let capturedAfter: (() => unknown) | null = null;
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (fn: () => unknown) => { capturedAfter = fn; } };
});

import { POST } from '../route';

function sign(body: string, timestamp: string, secret = SECRET): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
}

function signedRequest(body: string): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request('https://example.com/api/webhooks/tok-abc', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-pagespace-signature': sign(body, timestamp),
      'x-pagespace-timestamp': timestamp,
    },
  });
}

const VALID_PAYLOAD = JSON.stringify({ content: 'deploy finished' });

beforeEach(() => {
  vi.clearAllMocks();
  capturedAfter = null;
  selectCallIndex = 0;

  mockPageWebhookFindFirst.mockResolvedValue(WEBHOOK);
  mockWebhookTriggersFindMany.mockResolvedValue([TRIGGER]);
  mockDispatch.mockResolvedValue({ kind: 'handled' });

  mockCheckDistributedRateLimit.mockResolvedValue({ allowed: true });
  mockIsUserDriveMember.mockResolvedValue(true);
  mockCanConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });
  mockReleaseHold.mockResolvedValue(undefined);
  mockExecuteWorkflow.mockResolvedValue({ success: true, durationMs: 5 });

  // Fixed sequence executePageWebhookTrigger walks for a single trigger fire:
  // 1) workflows row, 2) webhook -> pageId, 3) webhook page (drive/trashed),
  // 4) agent page (drive/trashed), 5) billing owner row.
  selectQueue = [
    [WORKFLOW],
    [{ pageId: WEBHOOK.pageId }],
    [{ driveId: WORKFLOW.driveId, isTrashed: false }],
    [{ id: WORKFLOW.agentPageId, isTrashed: false, driveId: WORKFLOW.driveId }],
    [{ subscriptionTier: 'free' }],
  ];
});

describe('Incoming Webhooks: composability (real trigger fan-out reaches executeWorkflow)', () => {
  it('one signed POST to a CHANNEL webhook with an enabled trigger runs the default action AND fires the bound workflow — exactly once each', async () => {
    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(200);

    // The default CHANNEL action ran for this delivery, and was told triggers
    // are firing alongside it (not instead of it).
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ webhookId: WEBHOOK.id, pageId: WEBHOOK.pageId, hasEnabledTriggers: true }),
    );

    // The bound workflow trigger hasn't run yet — it's deferred to after().
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();

    // Flush the after() fan-out: the REAL firePageWebhookTriggers ->
    // executePageWebhookTrigger pipeline runs (drive-match guard, credit gate,
    // prompt construction all execute as written) and reaches the mocked
    // executeWorkflow boundary — for the SAME delivery that already ran the
    // channel action above.
    expect(capturedAfter).not.toBeNull();
    await capturedAfter?.();

    expect(mockExecuteWorkflow).toHaveBeenCalledTimes(1);
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: WORKFLOW.id,
        driveId: WORKFLOW.driveId,
        createdBy: WORKFLOW.createdBy,
        source: expect.objectContaining({ table: 'webhookTriggers', id: TRIGGER.id }),
      }),
    );
    // The channel action still only ran once — the fan-out didn't duplicate it.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it('does not touch executeWorkflow when the webhook has no bound triggers (paths are decoupled, not implicitly linked)', async () => {
    mockWebhookTriggersFindMany.mockResolvedValue([]);

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(200);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ hasEnabledTriggers: false }));
    expect(capturedAfter).toBeNull();
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
  });

  it('skips (and does not execute) a trigger whose webhook page has moved to a different drive than the workflow — the fire-time guard runs for real', async () => {
    selectQueue = [
      [WORKFLOW],
      [{ pageId: WEBHOOK.pageId }],
      [{ driveId: 'some-other-drive', isTrashed: false }], // webhook page moved out of the workflow's drive
    ];

    const response = await POST(signedRequest(VALID_PAYLOAD), { params: Promise.resolve({ token: 'tok-abc' }) });
    expect(response.status).toBe(200);

    // The fan-out WAS scheduled — the guard, not a missing after(), is what
    // must prevent execution. Without this, a regression that stopped after()
    // from firing at all would make the not-called assertion below pass for
    // the wrong reason.
    expect(capturedAfter).not.toBeNull();
    await capturedAfter?.();

    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    // The channel action still ran — a stale trigger binding doesn't block it.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});
