import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ZoomConnection } from '@pagespace/db/schema/zoom';
import type { WebhookTrigger } from '@pagespace/db/schema/webhook-triggers';

const {
  mockExecuteWorkflow,
  mockCanConsumeAI,
  mockReleaseHold,
  mockSelect,
  mockSelectFrom,
  mockSelectWhere,
  mockIsUserDriveMember,
  makeChildLogger,
} = vi.hoisted(() => {
  const makeChildLogger = (): Record<string, unknown> => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => makeChildLogger()),
  });
  return {
    mockExecuteWorkflow: vi.fn(),
    mockCanConsumeAI: vi.fn(),
    mockReleaseHold: vi.fn(),
    mockSelect: vi.fn(),
    mockSelectFrom: vi.fn(),
    mockSelectWhere: vi.fn(),
    mockIsUserDriveMember: vi.fn(),
    makeChildLogger,
  };
});

vi.mock('@pagespace/db/db', () => ({ db: { select: mockSelect } }));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', subscriptionTier: 'subscriptionTier' } }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id', isTrashed: 'isTrashed' } }));
vi.mock('@pagespace/db/schema/workflows', () => ({ workflows: { id: 'id' } }));
vi.mock('@/lib/workflows/workflow-executor', () => ({ executeWorkflow: mockExecuteWorkflow }));
vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: mockCanConsumeAI }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: mockReleaseHold }));
vi.mock('@pagespace/lib/permissions/permissions', () => ({ isUserDriveMember: mockIsUserDriveMember }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { child: vi.fn(() => makeChildLogger()), info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

import { executeWebhookTrigger } from '../webhook-trigger-executor';

// Northwind: a Zoom meeting-ended trigger on Product's weekly-digest agent; Marcus owns the Zoom connection.
const TRIGGER = { id: 'trg-1', workflowId: 'wf-1' } as WebhookTrigger;
const CONNECTION = { userId: 'user-marcus' } as ZoomConnection;
const EVENT = { event: 'meeting.ended', payload: { object: { topic: 'Standup' } } };
const PRODUCT_AUTOMATION = { kind: 'automation', driveId: 'drive-product' };

const workflowRow = () => ({
  id: 'wf-1',
  driveId: 'drive-product',
  agentPageId: 'agent-1',
  prompt: 'Summarize the meeting',
  contextPageIds: [],
  instructionPageId: null,
  timezone: 'UTC',
});

describe('executeWebhookTrigger (Zoom)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsUserDriveMember.mockResolvedValue(true);
    mockCanConsumeAI.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1', walletId: 'w-product' });
    mockReleaseHold.mockResolvedValue(undefined);
    mockSelect.mockReturnValue({ from: mockSelectFrom });
    mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
    mockSelectWhere
      .mockResolvedValueOnce([workflowRow()])                        // workflow load
      .mockResolvedValueOnce([{ id: 'agent-1', isTrashed: false }])  // agent preflight
      .mockResolvedValueOnce([{ subscriptionTier: 'pro' }]);         // connection owner tier
    mockExecuteWorkflow.mockResolvedValue({ success: true, durationMs: 5 });
  });

  it('SPEND-6 (partial) the gate names the drive as consumer, never the connection owner\'s credits', async () => {
    await executeWebhookTrigger(TRIGGER, EVENT, CONNECTION);

    expect(mockCanConsumeAI).toHaveBeenCalledWith('user-marcus', 'pro', { spend: PRODUCT_AUTOMATION, skipDailyCap: true });
  });

  it('SPEND-6 (partial) the run settles on the drive wallet the gate reserved on, and the hold is released', async () => {
    const result = await executeWebhookTrigger(TRIGGER, EVENT, CONNECTION);

    expect(result.success).toBe(true);
    expect(mockExecuteWorkflow.mock.calls[0][1]).toEqual({ creditSpend: { spend: PRODUCT_AUTOMATION, walletId: 'w-product' } });
    expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
  });

  it('SPEND-6 (partial) with only the person funded and the drive wallet empty the run is skipped, naming why', async () => {
    mockCanConsumeAI.mockResolvedValue({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] },
    });

    const result = await executeWebhookTrigger(TRIGGER, EVENT, CONNECTION);

    expect(result).toMatchObject({ success: false, error: 'AI credit gate denied: source_refused (drive_wallet_empty)' });
    expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    expect(mockCanConsumeAI).toHaveBeenCalledTimes(1);
  });
});
