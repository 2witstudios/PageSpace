import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
const mockIsOnPrem = vi.hoisted(() => vi.fn(() => false));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

vi.mock('../../security/distributed-rate-limit', () => ({
  checkDistributedRateLimit: vi.fn(async () => ({ allowed: true, attemptsRemaining: 2 })),
}));

vi.mock('../../deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

import { sendEmail, resolveAppUrl } from '../email-service';
import { checkDistributedRateLimit } from '../../security/distributed-rate-limit';

describe('email-service', () => {
  const origApiKey = process.env.RESEND_API_KEY;
  const origFromEmail = process.env.FROM_EMAIL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnPrem.mockReturnValue(false);
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.FROM_EMAIL = 'test@example.com';
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, attemptsRemaining: 2 });
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = origApiKey;
    process.env.FROM_EMAIL = origFromEmail;
  });

  it('given cloud mode + missing api key, should throw', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).rejects.toThrow('RESEND_API_KEY environment variable is required');
  });

  it('given cloud mode + rate limited recipient, should throw', async () => {
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: false, retryAfter: 60 });
    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).rejects.toThrow('Too many emails sent to user@test.com');
  });

  it('given cloud mode, should send email via Resend', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await sendEmail({ to: 'user@test.com', subject: 'Test', react: null });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Test',
      })
    );
  });

  it('given tenant mode, should send email via Resend', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await sendEmail({ to: 'user@test.com', subject: 'Test', react: null });
    expect(mockSend).toHaveBeenCalled();
  });

  it('given cloud mode + Resend error, should throw', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'Bad request' } });

    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).rejects.toThrow('Failed to send email: Bad request');
  });

  it('given onprem mode, should no-op without calling Resend', async () => {
    mockIsOnPrem.mockReturnValue(true);
    await sendEmail({ to: 'user@test.com', subject: 'Test', react: null });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('given onprem mode, should not throw', async () => {
    mockIsOnPrem.mockReturnValue(true);
    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).resolves.toBeUndefined();
  });
});

describe('resolveAppUrl', () => {
  const origWeb = process.env.WEB_APP_URL;
  const origNext = process.env.NEXT_PUBLIC_APP_URL;

  afterEach(() => {
    process.env.WEB_APP_URL = origWeb;
    process.env.NEXT_PUBLIC_APP_URL = origNext;
  });

  it('returns WEB_APP_URL when set', () => {
    process.env.WEB_APP_URL = 'https://pagespace.ai';
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(resolveAppUrl()).toBe('https://pagespace.ai');
  });

  it('falls back to NEXT_PUBLIC_APP_URL when WEB_APP_URL is absent', () => {
    delete process.env.WEB_APP_URL;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.pagespace.ai';
    expect(resolveAppUrl()).toBe('https://app.pagespace.ai');
  });

  it('strips trailing slash from the URL', () => {
    process.env.WEB_APP_URL = 'https://pagespace.ai/';
    expect(resolveAppUrl()).toBe('https://pagespace.ai');
  });

  it('prefers WEB_APP_URL over NEXT_PUBLIC_APP_URL', () => {
    process.env.WEB_APP_URL = 'https://web.example.com';
    process.env.NEXT_PUBLIC_APP_URL = 'https://next.example.com';
    expect(resolveAppUrl()).toBe('https://web.example.com');
  });

  it('throws when neither env var is set', () => {
    delete process.env.WEB_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => resolveAppUrl()).toThrow('App base URL is not configured');
  });

  it('throws on a relative path value', () => {
    process.env.WEB_APP_URL = 'relative/path';
    expect(() => resolveAppUrl()).toThrow('not a valid absolute URL');
  });

  it('throws on a non-http protocol', () => {
    process.env.WEB_APP_URL = 'ftp://example.com';
    expect(() => resolveAppUrl()).toThrow('must use http or https protocol');
  });
});
