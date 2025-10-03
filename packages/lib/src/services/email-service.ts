import { Resend } from 'resend';
import { checkRateLimit, RATE_LIMIT_CONFIGS } from '../rate-limit-utils';
import type { ReactElement } from 'react';

function getResendConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.FROM_EMAIL || 'PageSpace <onboarding@resend.dev>';

  if (!apiKey) {
    throw new Error('RESEND_API_KEY environment variable is required');
  }

  return { apiKey, from };
}

let resendInstance: Resend | null = null;

function getResend(): Resend {
  if (!resendInstance) {
    const config = getResendConfig();
    resendInstance = new Resend(config.apiKey);
  }
  return resendInstance;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  react: ReactElement;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  const config = getResendConfig();
  const resend = getResend();

  // Rate limit email sending (3 per hour per recipient)
  const rateLimit = checkRateLimit(`email:${options.to}`, {
    maxAttempts: 3,
    windowMs: 60 * 60 * 1000, // 1 hour
    blockDurationMs: 60 * 60 * 1000,
  });

  if (!rateLimit.allowed) {
    throw new Error(`Too many emails sent to ${options.to}. Please try again later.`);
  }

  const { data, error } = await resend.emails.send({
    from: config.from,
    to: options.to,
    subject: options.subject,
    react: options.react,
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return data as unknown as void;
}
