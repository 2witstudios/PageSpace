// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindMany = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: { query: { webhookTriggers: { findMany: (...a: unknown[]) => mockFindMany(...a) } } },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
}));
vi.mock('@pagespace/db/schema/webhook-triggers', () => ({
  webhookTriggers: { pageWebhookId: 'pwid', isEnabled: 'enabled' },
}));

import {
  findEnabledPageWebhookTriggers,
  MAX_PAGE_WEBHOOK_TRIGGERS,
} from '../page-webhook-trigger-queries';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));

beforeEach(() => vi.clearAllMocks());

describe('findEnabledPageWebhookTriggers', () => {
  it('fetches one more than the cap so overflow is detectable', async () => {
    mockFindMany.mockResolvedValue(rows(3));
    await findEnabledPageWebhookTriggers('wh-1');
    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_PAGE_WEBHOOK_TRIGGERS + 1 }),
    );
  });

  it('returns the full set when at or under the cap', async () => {
    mockFindMany.mockResolvedValue(rows(MAX_PAGE_WEBHOOK_TRIGGERS));
    const result = await findEnabledPageWebhookTriggers('wh-1');
    expect(result.success).toBe(true);
    expect(result.success && result.data.length).toBe(MAX_PAGE_WEBHOOK_TRIGGERS);
  });

  it('fails (does NOT return a truncated set) when the webhook has more than the cap of enabled triggers', async () => {
    mockFindMany.mockResolvedValue(rows(MAX_PAGE_WEBHOOK_TRIGGERS + 1));
    const result = await findEnabledPageWebhookTriggers('wh-1');
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toMatch(/more than/);
  });

  it('returns a failure result (never throws) when the query errors', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    const result = await findEnabledPageWebhookTriggers('wh-1');
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toBe('db down');
  });
});
