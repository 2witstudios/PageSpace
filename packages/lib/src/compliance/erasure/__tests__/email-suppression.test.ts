import { describe, it, expect, vi } from 'vitest';
import {
  buildEmailSuppressionPlan,
  syncEmailSuppression,
  type EmailSuppressionClient,
} from '../email-suppression';

describe('buildEmailSuppressionPlan', () => {
  it('given cloud mode + valid email, should produce a normalized suppression entry', () => {
    const plan = buildEmailSuppressionPlan({
      email: '  Alice@Example.COM ',
      userId: 'u1',
      deploymentMode: 'cloud',
    });
    expect(plan.shouldSuppress).toBe(true);
    expect(plan.entries).toEqual([
      { email: 'alice@example.com', reason: 'gdpr_erasure', userId: 'u1' },
    ]);
  });

  it('given on-prem mode, should not suppress (no external email provider)', () => {
    const plan = buildEmailSuppressionPlan({
      email: 'alice@example.com',
      userId: 'u1',
      deploymentMode: 'onprem',
    });
    expect(plan.shouldSuppress).toBe(false);
    expect(plan.entries).toEqual([]);
  });

  it('given an invalid email, should produce no entries even in cloud mode', () => {
    const plan = buildEmailSuppressionPlan({
      email: 'not-an-email',
      userId: 'u1',
      deploymentMode: 'cloud',
    });
    expect(plan.shouldSuppress).toBe(false);
    expect(plan.entries).toEqual([]);
  });

  it('given tenant mode, should suppress like cloud', () => {
    const plan = buildEmailSuppressionPlan({
      email: 'a@b.io',
      userId: 'u1',
      deploymentMode: 'tenant',
    });
    expect(plan.shouldSuppress).toBe(true);
  });
});

describe('syncEmailSuppression', () => {
  it('given a suppressible plan, should call the client once per entry and report counts', async () => {
    const client: EmailSuppressionClient = { suppress: vi.fn().mockResolvedValue(undefined) };
    const result = await syncEmailSuppression(
      { email: 'a@b.io', userId: 'u1', deploymentMode: 'cloud' },
      client
    );
    expect(client.suppress).toHaveBeenCalledTimes(1);
    expect(result.suppressed).toBe(1);
    expect(result.skipped).toBe(false);
  });

  it('given on-prem, should skip without calling the client', async () => {
    const client: EmailSuppressionClient = { suppress: vi.fn() };
    const result = await syncEmailSuppression(
      { email: 'a@b.io', userId: 'u1', deploymentMode: 'onprem' },
      client
    );
    expect(client.suppress).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });

  it('given the client throws, should swallow and count the failure (never block erasure)', async () => {
    const client: EmailSuppressionClient = {
      suppress: vi.fn().mockRejectedValue(new Error('resend 500')),
    };
    const result = await syncEmailSuppression(
      { email: 'a@b.io', userId: 'u1', deploymentMode: 'cloud' },
      client
    );
    expect(result.suppressed).toBe(0);
    expect(result.failed).toBe(1);
  });
});
