import React from 'react';
import { VerificationEmail } from '../src/email-templates/VerificationEmail';

export default function VerificationEmailPreview() {
  return (
    <VerificationEmail
      userName="Sarah Chen"
      verificationUrl="https://app.pagespace.com/verify?token=abc123xyz789def456ghi012jkl345mno678pqr901stu234"
    />
  );
}
