/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';

// ============================================================================
// Contract Tests for PUT /api/admin/users/[userId]/subscription
//
// This is a deprecated endpoint that always returns 410 Gone.
// ============================================================================

import { PUT } from '../route';

describe('PUT /api/admin/users/[userId]/subscription', () => {
  it('should return 410 Gone (deprecated endpoint)', async () => {
    const request = new Request('https://example.com/api/admin/users/user_1/subscription', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: 'pro' }),
    });

    const context = { params: Promise.resolve({ userId: 'user_1' }) };
    const response = await PUT(request, context);
    const body = await response.json();

    expect(response.status).toBe(410);
    expect(body.error).toBe('This endpoint is deprecated');
    expect(body.migration).toHaveProperty('giftSubscription');
    expect(body.migration).toHaveProperty('revokeSubscription');
  });

  it('should include migration paths in response', async () => {
    const request = new Request('https://example.com/api/admin/users/user_1/subscription', {
      method: 'PUT',
    });

    const context = { params: Promise.resolve({ userId: 'user_1' }) };
    const response = await PUT(request, context);
    const body = await response.json();

    expect(body.migration.giftSubscription).toBe('POST /api/admin/users/[userId]/gift-subscription');
    expect(body.migration.revokeSubscription).toBe('DELETE /api/admin/users/[userId]/gift-subscription');
  });

  it('should handle any userId parameter (always returns 410)', async () => {
    const request = new Request('https://example.com/api/admin/users/nonexistent/subscription', {
      method: 'PUT',
    });

    const context = { params: Promise.resolve({ userId: 'nonexistent' }) };
    const response = await PUT(request, context);

    expect(response.status).toBe(410);
  });
});
