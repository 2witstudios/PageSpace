import { Resend } from 'resend';
import { checkDistributedRateLimit } from '../security/distributed-rate-limit';
import { isOnPrem } from '../deployment-mode';
import type * as React from 'react';

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

export function resolveAppUrl(): string {
  const url = process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (!url) {
    throw new Error(
      'App base URL is not configured. Set WEB_APP_URL or NEXT_PUBLIC_APP_URL environment variable.'
    );
  }
  const normalized = url.replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(
      `App base URL is not a valid absolute URL: ${normalized}. Set WEB_APP_URL or NEXT_PUBLIC_APP_URL to a valid URL.`
    );
  }
  if (!parsed.protocol.startsWith('http')) {
    throw new Error(`App base URL must use http or https protocol, got: ${parsed.protocol}`);
  }
  return normalized;
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  react: React.ReactNode;
  /**
   * Extra SMTP headers. Bulk sends need `List-Unsubscribe` and
   * `List-Unsubscribe-Post` — Gmail and Yahoo's bulk-sender rules require a
   * one-click unsubscribe header, and a body link alone does not satisfy them.
   */
  headers?: Record<string, string>;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  if (isOnPrem()) {
    console.warn('[email-service] Email sending is disabled in on-premise deployment mode');
    return;
  }

  const config = getResendConfig();
  const resend = getResend();

  // Rate limit email sending (3 per hour per recipient).
  // Postgres-backed so the limit survives restarts and spans replicas (#977).
  const rateLimit = await checkDistributedRateLimit(`email:${options.to}`, {
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
    react: options.react as React.ReactNode,
    ...(options.headers ? { headers: options.headers } : {}),
  });

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`);
  }

  return data as unknown as void;
}
