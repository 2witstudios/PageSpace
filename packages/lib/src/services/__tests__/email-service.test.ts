import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockSend = vi.fn();

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: mockSend },
  })),
}));

vi.mock('../../auth/rate-limit-utils', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true, attemptsRemaining: 2 })),
  RATE_LIMIT_CONFIGS: {},
}));

import { sendEmail } from '../email-service';
import { checkRateLimit } from '../../auth/rate-limit-utils';

describe('email-service', () => {
  const origApiKey = process.env.RESEND_API_KEY;
  const origFromEmail = process.env.FROM_EMAIL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = 'test-api-key';
    process.env.FROM_EMAIL = 'test@example.com';
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, attemptsRemaining: 2 });
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = origApiKey;
    process.env.FROM_EMAIL = origFromEmail;
  });

  it('should throw when RESEND_API_KEY is not set', async () => {
    delete process.env.RESEND_API_KEY;
    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).rejects.toThrow('RESEND_API_KEY environment variable is required');
  });

  it('should throw when rate limited', async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, retryAfter: 60 });
    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).rejects.toThrow('Too many emails sent to user@test.com');
  });

  it('should send email successfully', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await sendEmail({ to: 'user@test.com', subject: 'Test', react: null });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@test.com',
        subject: 'Test',
      })
    );
  });

  it('should throw when Resend returns an error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'Bad request' } });

    await expect(
      sendEmail({ to: 'user@test.com', subject: 'Test', react: null })
    ).rejects.toThrow('Failed to send email: Bad request');
  });
});
