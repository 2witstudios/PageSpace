import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();
const mockIsOnPrem = vi.hoisted(() => vi.fn(() => false));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

vi.mock('../../auth/rate-limit-utils', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, attemptsRemaining: 2 })),
  RATE_LIMIT_CONFIGS: {},
}));

vi.mock('../../deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

import { sendEmail } from '../email-service';
import { checkRateLimit } from '../../auth/rate-limit-utils';

describe('email-service', () => {
  const origApiKey = process.env.RESEND_API_KEY;
  const origFromEmail = process.env.FROM_EMAIL;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsOnPrem.mockReturnValue(false);
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.FROM_EMAIL = 'test@example.com';
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, attemptsRemaining: 2 });
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
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfter: 60 });
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
