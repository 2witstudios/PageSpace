import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

vi.mock('@pagespace/lib/consent/ai-consent-service', () => ({
  getActiveAiConsent: vi.fn(),
  hasActiveAiConsent: vi.fn(),
  recordAiConsent: vi.fn(),
  revokeAiConsent: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { error: vi.fn(), info: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: vi.fn(),
}));

import { GET, POST, DELETE } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  getActiveAiConsent,
  hasActiveAiConsent,
  recordAiConsent,
  revokeAiConsent,
} from '@pagespace/lib/consent/ai-consent-service';
import { AI_CONSENT_POLICY_VERSION } from '@pagespace/lib/consent';

const userId = 'user_123';
const req = () => new Request('http://localhost/api/consent/ai-processing', { method: 'POST' });

const authOk = () => {
  vi.mocked(isAuthError).mockReturnValue(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ userId } as any);
};

beforeEach(() => {
  vi.clearAllMocks();
  authOk();
});

describe('GET /api/consent/ai-processing', () => {
  it('reports consented:true when an active valid record exists', async () => {
    vi.mocked(getActiveAiConsent).mockResolvedValue({
      userId, policyVersion: AI_CONSENT_POLICY_VERSION, consentedAt: '2026-06-24T00:00:00.000Z', revokedAt: null,
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.consented).toBe(true);
    expect(body.policyVersion).toBe(AI_CONSENT_POLICY_VERSION);
  });

  it('reports consented:false when the record is a stale policy version', async () => {
    vi.mocked(getActiveAiConsent).mockResolvedValue({
      userId, policyVersion: AI_CONSENT_POLICY_VERSION - 1, consentedAt: '2026-06-24T00:00:00.000Z', revokedAt: null,
    });
    const res = await GET(req());
    const body = await res.json();
    expect(body.consented).toBe(false);
  });

  it('reports consented:false when there is no record', async () => {
    vi.mocked(getActiveAiConsent).mockResolvedValue(null);
    const res = await GET(req());
    expect((await res.json()).consented).toBe(false);
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(isAuthError).mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) } as any);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });
});

describe('POST /api/consent/ai-processing', () => {
  it('records consent when none is active', async () => {
    vi.mocked(hasActiveAiConsent).mockResolvedValue(false);
    const res = await POST(req());
    expect(recordAiConsent).toHaveBeenCalledWith(userId);
    expect((await res.json()).consented).toBe(true);
  });

  it('does not double-record when consent is already active', async () => {
    vi.mocked(hasActiveAiConsent).mockResolvedValue(true);
    const res = await POST(req());
    expect(recordAiConsent).not.toHaveBeenCalled();
    expect((await res.json()).consented).toBe(true);
  });
});

describe('DELETE /api/consent/ai-processing', () => {
  it('revokes consent', async () => {
    const res = await DELETE(req());
    expect(revokeAiConsent).toHaveBeenCalledWith(userId);
    expect((await res.json()).consented).toBe(false);
  });
});
