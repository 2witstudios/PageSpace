import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for the enqueue helper's failure CLASSIFICATION — the logic that keeps
 * an ambiguous transport failure from being reported as "definitely failed"
 * (which would let the worker send mail under a `failed` status and invite the
 * admin to create a duplicate broadcast).
 *
 * The reconciliation retry leans on the processor's `singletonKey: broadcastId`
 * dedupe: re-POSTing the same id cannot start a second concurrent job, and its
 * 409 is positive proof the lost first attempt landed.
 */

vi.mock('@pagespace/lib/services/validated-service-token', () => ({
  createUserServiceToken: vi.fn().mockResolvedValue({ token: 'svc-token' }),
}));

import {
  BroadcastEnqueueUnconfirmedError,
  BroadcastNotEnqueuedError,
  enqueueBroadcast,
} from '../enqueue';
import { createUserServiceToken } from '@pagespace/lib/services/validated-service-token';

const params = { broadcastId: 'bc_1', callerUserId: 'admin_1' };

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('enqueueBroadcast', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createUserServiceToken).mockResolvedValue({ token: 'svc-token' } as never);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the jobId on a clean 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, jobId: 'job_1' }));

    await expect(enqueueBroadcast(params)).resolves.toEqual({ jobId: 'job_1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(createUserServiceToken).toHaveBeenCalledWith('admin_1', ['broadcast:enqueue'], '2m');
  });

  it('treats a 409 (singletonKey dedupe) as success with an unknown jobId', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'already queued' }));

    await expect(enqueueBroadcast(params)).resolves.toEqual({ jobId: null });
  });

  it('throws NotEnqueued on a non-409 4xx — the processor examined and refused', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'bad scope' }));

    await expect(enqueueBroadcast(params)).rejects.toBeInstanceOf(BroadcastNotEnqueuedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws NotEnqueued when token minting fails — no request ever left', async () => {
    vi.mocked(createUserServiceToken).mockRejectedValue(new Error('no such user'));

    await expect(enqueueBroadcast(params)).rejects.toBeInstanceOf(BroadcastNotEnqueuedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovers a lost response via the reconciliation retry: network error then 409', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'already queued' }));

    // The 409 proves the first attempt landed: confirmed, id unknown.
    await expect(enqueueBroadcast(params)).resolves.toEqual({ jobId: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers a dropped first attempt via the retry: network error then 200', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, jobId: 'job_2' }));

    await expect(enqueueBroadcast(params)).resolves.toEqual({ jobId: 'job_2' });
  });

  it('converts an ambiguous 5xx into a definite refusal when the retry 4xxes', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'broadcastId is required' }));

    await expect(enqueueBroadcast(params)).rejects.toBeInstanceOf(BroadcastNotEnqueuedError);
  });

  it('throws Unconfirmed only when both attempts fail ambiguously', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));

    await expect(enqueueBroadcast(params)).rejects.toBeInstanceOf(BroadcastEnqueueUnconfirmedError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a 2xx with no jobId in the body as ambiguous, not success', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true }))
      .mockResolvedValueOnce(jsonResponse(409, { error: 'already queued' }));

    await expect(enqueueBroadcast(params)).resolves.toEqual({ jobId: null });
  });
});
