import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/db/db', () => ({ db: { update: vi.fn() } }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', tokenVersion: 'tokenVersion' } }));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(() => 'eq'),
  sql: Object.assign((parts: TemplateStringsArray) => ({ sql: parts.join('') }), { placeholder: vi.fn() }),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { auth: { info: vi.fn(), error: vi.fn() } },
}));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isCloud: vi.fn() }));
vi.mock('@pagespace/lib/repositories/data-subject-request-repository', () => ({
  dataSubjectRequestRepository: {
    create: vi.fn(),
    appendStepResult: vi.fn(),
    markQueued: vi.fn(),
    markFailed: vi.fn(),
  },
}));
vi.mock('@/lib/stripe/client', () => ({ stripe: { customers: { del: vi.fn() } } }));
vi.mock('../enqueue', () => ({ enqueueAccountErasure: vi.fn() }));

import { lodgeAndEnqueueErasure } from '../request-erasure';
import { db } from '@pagespace/db/db';
import { isCloud } from '@pagespace/lib/deployment-mode';
import { dataSubjectRequestRepository } from '@pagespace/lib/repositories/data-subject-request-repository';
import { stripe } from '@/lib/stripe/client';
import { enqueueAccountErasure } from '../enqueue';

const repo = vi.mocked(dataSubjectRequestRepository);

beforeEach(() => {
  vi.clearAllMocks();
  repo.create.mockResolvedValue({
    id: 'dsr_1',
    slaDeadline: new Date('2026-03-01T00:00:00.000Z'),
  } as never);
  repo.appendStepResult.mockResolvedValue(undefined);
  repo.markQueued.mockResolvedValue(1);
  repo.markFailed.mockResolvedValue(undefined);
  const whereFn = vi.fn().mockResolvedValue(undefined);
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  vi.mocked(db.update).mockReturnValue({ set: setFn } as never);
  vi.mocked(enqueueAccountErasure).mockResolvedValue('job_1');
  vi.mocked(isCloud).mockReturnValue(false);
});

const baseInput = {
  subjectUserId: 'u1',
  subjectEmail: 'a@b.com',
  stripeCustomerId: null,
  callerUserId: 'u1',
  requestedByType: 'self' as const,
  forceDelete: false,
};

describe('lodgeAndEnqueueErasure', () => {
  it('should create the DSR first, enqueue, then mark it queued with the jobId', async () => {
    const result = await lodgeAndEnqueueErasure(baseInput);

    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(enqueueAccountErasure).toHaveBeenCalledWith({
      requestId: 'dsr_1',
      userId: 'u1',
      callerUserId: 'u1',
    });
    expect(repo.markQueued).toHaveBeenCalledWith('dsr_1', 'job_1');
    expect(result).toEqual({
      requestId: 'dsr_1',
      jobId: 'job_1',
      slaDeadline: new Date('2026-03-01T00:00:00.000Z'),
    });
  });

  it('should bump the subject tokenVersion to lock sessions immediately', async () => {
    await lodgeAndEnqueueErasure(baseInput);
    expect(db.update).toHaveBeenCalled();
  });

  it('given non-cloud, should record stripe step as skipped (no Stripe call)', async () => {
    await lodgeAndEnqueueErasure(baseInput);
    expect(stripe.customers.del).not.toHaveBeenCalled();
    expect(repo.appendStepResult).toHaveBeenCalledWith(
      'dsr_1',
      expect.objectContaining({ step: 'stripe-customer', status: 'skipped' })
    );
  });

  it('given cloud + stripeCustomerId, should delete the customer and record ok', async () => {
    vi.mocked(isCloud).mockReturnValue(true);
    vi.mocked(stripe.customers.del).mockResolvedValue({} as never);
    await lodgeAndEnqueueErasure({ ...baseInput, stripeCustomerId: 'cus_1' });
    expect(stripe.customers.del).toHaveBeenCalledWith('cus_1');
    expect(repo.appendStepResult).toHaveBeenCalledWith(
      'dsr_1',
      expect.objectContaining({ step: 'stripe-customer', status: 'ok' })
    );
  });

  it('given Stripe failure, should record failed but still enqueue (never block erasure)', async () => {
    vi.mocked(isCloud).mockReturnValue(true);
    vi.mocked(stripe.customers.del).mockRejectedValue(new Error('stripe down'));
    const result = await lodgeAndEnqueueErasure({ ...baseInput, stripeCustomerId: 'cus_1' });
    expect(repo.appendStepResult).toHaveBeenCalledWith(
      'dsr_1',
      expect.objectContaining({ step: 'stripe-customer', status: 'failed' })
    );
    expect(result.jobId).toBe('job_1');
  });

  it('given enqueue throws, should mark the DSR failed (not leave it pending) and rethrow', async () => {
    vi.mocked(enqueueAccountErasure).mockRejectedValue(new Error('processor down'));
    await expect(lodgeAndEnqueueErasure(baseInput)).rejects.toThrow('processor down');
    expect(repo.markFailed).toHaveBeenCalledWith('dsr_1', expect.stringContaining('processor down'));
    expect(repo.markQueued).not.toHaveBeenCalled();
  });
});
