/**
 * An abandoned agent is erased through the platform's GDPR account-erasure
 * path (a data-subject-request row, Stripe/Apple steps, tokenVersion bump,
 * the processor's durable erasure job) — never a raw delete — and only if the
 * subject really is an agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findActiveErasureForUser: vi.fn(),
  lodgeAndEnqueueErasure: vi.fn(),
  selectRows: [] as Array<{ accountType: string; stripeCustomerId: string | null; appleId: string | null }>,
}));

vi.mock('@pagespace/lib/repositories/data-subject-request-repository', () => ({
  dataSubjectRequestRepository: { findActiveErasureForUser: mocks.findActiveErasureForUser },
}));
vi.mock('@/lib/erasure/request-erasure', () => ({ lodgeAndEnqueueErasure: mocks.lodgeAndEnqueueErasure }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.selectRows }) }) }),
  },
}));

import { AGENT_LIFECYCLE_LEGAL_BASIS, eraseUnclaimedAgent } from '../lifecycle-erasure';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectRows = [{ accountType: 'agent', stripeCustomerId: null, appleId: null }];
  mocks.findActiveErasureForUser.mockResolvedValue(null);
  mocks.lodgeAndEnqueueErasure.mockResolvedValue({ requestId: 'dsr_1', jobId: 'job_1' });
});

describe('eraseUnclaimedAgent', () => {
  it('lodges a GDPR erasure for the agent with its synthetic address, as an automation acting for the agent', async () => {
    await eraseUnclaimedAgent('agent_1');

    expect(mocks.lodgeAndEnqueueErasure).toHaveBeenCalledTimes(1);
    const input = mocks.lodgeAndEnqueueErasure.mock.calls[0]?.[0];
    expect(input).toMatchObject({
      subjectUserId: 'agent_1',
      subjectEmail: 'agent-agent_1@agents.pagespace.invalid',
      stripeCustomerId: null,
      requestedByType: 'self',
      forceDelete: false,
      legalBasis: AGENT_LIFECYCLE_LEGAL_BASIS,
      subjectAppleLinked: false,
    });
    expect(input.caller).toMatchObject({ via: 'automation', userId: 'agent_1' });
  });

  it('does not lodge a second erasure while one is in flight', async () => {
    mocks.findActiveErasureForUser.mockResolvedValue({ id: 'dsr_0', status: 'queued' });
    await eraseUnclaimedAgent('agent_1');
    expect(mocks.lodgeAndEnqueueErasure).not.toHaveBeenCalled();
  });

  it('fails closed for anyone who is not an agent, or who no longer exists', async () => {
    mocks.selectRows = [{ accountType: 'human', stripeCustomerId: null, appleId: null }];
    await expect(eraseUnclaimedAgent('user_1')).rejects.toThrow();
    mocks.selectRows = [];
    await expect(eraseUnclaimedAgent('gone')).rejects.toThrow();
    expect(mocks.lodgeAndEnqueueErasure).not.toHaveBeenCalled();
  });
});
