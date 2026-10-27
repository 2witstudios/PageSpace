// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../webhook-trigger-queries', () => ({
  findMatchingWebhookTriggers: vi.fn(),
  claimTriggerFired: vi.fn(),
  setTriggerError: vi.fn(),
}));

vi.mock('../webhook-trigger-executor', () => ({
  executeWebhookTrigger: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } },
}));

import {
  findMatchingWebhookTriggers,
  claimTriggerFired,
  setTriggerError,
} from '../webhook-trigger-queries';
import { executeWebhookTrigger } from '../webhook-trigger-executor';
import { fireZoomWebhookTriggers } from '../fire-webhook-triggers';

const mockFind = findMatchingWebhookTriggers as unknown as ReturnType<typeof vi.fn>;
const mockClaim = claimTriggerFired as unknown as ReturnType<typeof vi.fn>;
const mockSetError = setTriggerError as unknown as ReturnType<typeof vi.fn>;
const mockExecute = executeWebhookTrigger as unknown as ReturnType<typeof vi.fn>;

const connection = { id: 'conn_1', userId: 'user_1' } as never;
const event = { event: 'recording.transcript_completed', payload: { meeting: 'abc' } };
const aTrigger = (id: string) => ({ id, workflowId: `wf_${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  mockClaim.mockResolvedValue({ success: true, data: undefined });
  mockSetError.mockResolvedValue({ success: true, data: undefined });
});

describe('fireZoomWebhookTriggers', () => {
  it('looks up triggers using the pre-resolved connection id and event type', async () => {
    mockFind.mockResolvedValue({ success: true, data: [] });

    await fireZoomWebhookTriggers(event, connection);

    expect(mockFind).toHaveBeenCalledWith('conn_1', 'recording.transcript_completed');
  });

  it('executes the workflow and claims the trigger on success', async () => {
    mockFind.mockResolvedValue({ success: true, data: [aTrigger('t1')] });
    mockExecute.mockResolvedValue({ success: true, durationMs: 1 });

    await fireZoomWebhookTriggers(event, connection);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockClaim).toHaveBeenCalledWith('t1');
    expect(mockSetError).not.toHaveBeenCalled();
  });

  it('records an error when the workflow execution reports failure', async () => {
    mockFind.mockResolvedValue({ success: true, data: [aTrigger('t1')] });
    mockExecute.mockResolvedValue({ success: false, durationMs: 1, error: 'boom' });

    await fireZoomWebhookTriggers(event, connection);

    expect(mockSetError).toHaveBeenCalledWith('t1', 'boom');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('records an error and continues when one execution throws', async () => {
    mockFind.mockResolvedValue({ success: true, data: [aTrigger('t1'), aTrigger('t2')] });
    mockExecute
      .mockRejectedValueOnce(new Error('exploded'))
      .mockResolvedValueOnce({ success: true, durationMs: 1 });

    await fireZoomWebhookTriggers(event, connection);

    expect(mockSetError).toHaveBeenCalledWith('t1', 'exploded');
    expect(mockClaim).toHaveBeenCalledWith('t2');
  });

  it('does nothing when there are no matching triggers', async () => {
    mockFind.mockResolvedValue({ success: true, data: [] });

    await fireZoomWebhookTriggers(event, connection);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockSetError).not.toHaveBeenCalled();
  });

  it('returns without throwing when the trigger lookup fails', async () => {
    mockFind.mockResolvedValue({ success: false, error: 'db down' });

    await expect(fireZoomWebhookTriggers(event, connection)).resolves.toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
