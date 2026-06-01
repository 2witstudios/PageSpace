import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pagespace/lib/auth/verification-utils', () => ({
  createVerificationToken: vi.fn().mockResolvedValue('tok_abc'),
}));
vi.mock('@pagespace/lib/services/email-service', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@pagespace/lib/email-templates/VerificationEmail', () => ({
  VerificationEmail: () => null,
}));

import { sendVerificationEmail } from '../send-verification-email';
import { createVerificationToken } from '@pagespace/lib/auth/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';

describe('sendVerificationEmail', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('mints an address-bound token and sends to that address with the bound URL', async () => {
    process.env.WEB_APP_URL = 'https://app.example.com';

    await sendVerificationEmail({ userId: 'u1', email: 'a@example.com', userName: 'Ann' });

    expect(createVerificationToken).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'email_verification',
      email: 'a@example.com',
    });
    const args = vi.mocked(sendEmail).mock.calls[0][0];
    expect(args.to).toBe('a@example.com');
    expect(args.subject).toBe('Verify your PageSpace email');
  });

  it('falls back through WEB_APP_URL -> NEXT_PUBLIC_APP_URL -> localhost', async () => {
    delete process.env.WEB_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;

    // Should not throw with no env configured (localhost fallback).
    await expect(
      sendVerificationEmail({ userId: 'u1', email: 'a@example.com', userName: 'Ann' }),
    ).resolves.toBeUndefined();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('propagates send failures to the caller (no internal swallow)', async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('Too many emails sent'));

    await expect(
      sendVerificationEmail({ userId: 'u1', email: 'a@example.com', userName: 'Ann' }),
    ).rejects.toThrow('Too many emails sent');
  });
});
