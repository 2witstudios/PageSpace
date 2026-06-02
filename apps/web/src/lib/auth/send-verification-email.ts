import React from 'react';
import { createVerificationToken } from '@pagespace/lib/auth/verification-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { VerificationEmail } from '@pagespace/lib/email-templates/VerificationEmail';

/**
 * Mint an address-bound `email_verification` token and send the verification
 * email to that address. Binding the token to `email` (stored in token
 * metadata) lets the verify step refuse to verify any other address than the
 * one the link was sent to.
 *
 * Throws on send failure — callers choose their own error policy (best-effort
 * for signup/profile updates, surfacing rate limits for explicit resends).
 * Centralizes the token binding, link path, subject, and template so every
 * entry point stays consistent.
 */
export async function sendVerificationEmail(params: {
  userId: string;
  email: string;
  userName: string;
}): Promise<void> {
  const { userId, email, userName } = params;

  const verificationToken = await createVerificationToken({
    userId,
    type: 'email_verification',
    email,
  });

  const baseUrl =
    process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  const verificationUrl = `${baseUrl}/api/auth/verify-email?token=${verificationToken}`;

  await sendEmail({
    to: email,
    subject: 'Verify your PageSpace email',
    react: React.createElement(VerificationEmail, { userName, verificationUrl }),
  });
}
