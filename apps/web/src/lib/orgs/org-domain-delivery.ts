/**
 * Sends the domain-ownership proof link (SEC-1) to an administrative mailbox of the domain. The link
 * opens the Wave F confirm page, which signs the person in and POSTs the token to
 * /api/orgs/domains/verify-email.
 */
import { resolveAppUrl } from '@pagespace/lib/services/email-service';
import { sendDomainVerificationEmail } from '@pagespace/lib/services/notification-email-service';
import { DOMAIN_EMAIL_PROOF_TTL_MS } from '@pagespace/lib/organizations/domains-core';
import { findOrganizationById } from '@pagespace/lib/organizations/repository';

export const domainProofUrl = (appUrl: string, token: string): string =>
  `${appUrl.replace(/\/+$/, '')}/orgs/domains/verify?token=${encodeURIComponent(token)}`;

export async function deliverDomainProof(input: { orgId: string; to: string; domain: string; token: string }): Promise<void> {
  const org = await findOrganizationById(input.orgId);
  await sendDomainVerificationEmail({
    recipientEmail: input.to,
    orgName: org?.name ?? 'an organization',
    domain: input.domain,
    expiresInHours: Math.round(DOMAIN_EMAIL_PROOF_TTL_MS / 3_600_000),
    verifyUrl: domainProofUrl(resolveAppUrl(), input.token),
  });
}
