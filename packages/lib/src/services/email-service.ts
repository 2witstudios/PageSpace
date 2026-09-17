import { Resend } from 'resend';
import {
  checkDistributedRateLimit,
  refundDistributedRateLimitAttempt,
} from '../security/distributed-rate-limit';
import { isOnPrem } from '../deployment-mode';
import { isAgentReservedEmail } from '../auth/agent/reserved-email';
import type * as React from 'react';

// Must match the windowMs passed to checkDistributedRateLimit below, so a
// refund decrements the same window bucket the failed attempt incremented.
const EMAIL_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

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
  /**
   * Skip the default per-recipient rate limit (10/hr). Use for notification
   * streams that are already gated by their own rate limiting upstream
   * (e.g. form submissions, which have their own IP/token rate limits).
   */
  skipRateLimit?: boolean;
  /**
   * Stable key that lets Resend collapse a retry into the original send.
   *
   * Without it, a send that Resend ACCEPTS but whose response we never receive
   * (socket timeout) is indistinguishable from one that never happened: the
   * caller records a failure, retries, and the recipient gets two copies. Any
   * caller that may retry a send should pass a key derived from the send's
   * identity (e.g. `sdk-launch:<userId>`), not a random one.
   */
  idempotencyKey?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<void> {
  if (isOnPrem()) {
    console.warn('[email-service] Email sending is disabled in on-premise deployment mode');
    return;
  }

  // An agent's synthetic address (ADR 0007 §4) is an RFC 2606 `.invalid`
  // domain: it can never receive mail, and a send would only earn a bounce.
  if (isAgentReservedEmail(options.to)) {
    console.warn('[email-service] Email suppressed: recipient is an agent account');
    return;
  }

  const config = getResendConfig();
  const resend = getResend();

  // Rate limit email sending (10 per hour per recipient). Every email type
  // (magic link, invite, notification) shares this bucket. A send that fails
  // below (a Resend rejection or a network error) has its attempt refunded —
  // see the catch block — so only accepted sends count against the cap;
  // otherwise a run of failures could lock a real user out of sign-in email
  // for the rest of the window.
  // Postgres-backed so the limit survives restarts and spans replicas (#977).
  const rateLimitKey = `email:${options.to}`;
  if (!options.skipRateLimit) {
    const rateLimit = await checkDistributedRateLimit(rateLimitKey, {
      maxAttempts: 10,
      windowMs: EMAIL_RATE_LIMIT_WINDOW_MS,
      blockDurationMs: 60 * 60 * 1000,
    });

    if (!rateLimit.allowed) {
      throw new Error(`Too many emails sent to ${options.to}. Please try again later.`);
    }
  }

  const payload = {
    from: config.from,
    to: options.to,
    subject: options.subject,
    react: options.react as React.ReactNode,
    ...(options.headers ? { headers: options.headers } : {}),
  };

  try {
    // Only pass the request-options argument when there is something to put in it,
    // so the common single-argument call stays exactly as it was.
    const { data, error } = options.idempotencyKey
      ? await resend.emails.send(payload, { idempotencyKey: options.idempotencyKey })
      : await resend.emails.send(payload);

    if (error) {
      throw new Error(`Failed to send email: ${error.message}`);
    }

    return data as unknown as void;
  } catch (err) {
    if (!options.skipRateLimit) {
      await refundDistributedRateLimitAttempt(rateLimitKey, EMAIL_RATE_LIMIT_WINDOW_MS);
    }
    throw err;
  }
}
