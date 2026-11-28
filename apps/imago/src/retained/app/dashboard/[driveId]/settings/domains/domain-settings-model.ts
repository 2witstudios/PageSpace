/** A custom domain's state as the list route reports it. */
export type DomainStatus = 'pending' | 'verified' | 'failed' | 'dns_failed' | 'provisioning' | 'active' | 'cert_failed';

/** The row's state label: "Secure" once the certificate is live, "DNS not found" until the records resolve. */
export const domainStatusLabel = (status: DomainStatus): string => {
  switch (status) {
    case 'active':
      return 'Secure';
    case 'provisioning':
      return 'Provisioning SSL';
    case 'verified':
      return 'DNS verified';
    case 'dns_failed':
    case 'failed':
      return 'DNS failed';
    case 'cert_failed':
      return 'SSL failed';
    case 'pending':
      return 'DNS not found';
  }
};

/** Whether a domain row still needs its DNS records (so the record table opens by default). */
export const needsDnsRecords = (status: DomainStatus): boolean =>
  status === 'pending' || status === 'failed' || status === 'dns_failed';

/** "2 of 3 on your plan", shown only when billing is enabled and the plan has a limit. */
export const domainCountLabel = (count: number, limit: number): string => `${count} of ${limit} on your plan`;

/**
 * Inline validation for an image URL field (default share image, favicon): empty is allowed
 * (it clears the setting), anything else must be a full http or https address.
 */
export const imageUrlError = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'http:' || url.protocol === 'https:') return null;
  } catch {
    // fall through to the message below
  }
  return 'Enter a full address that starts with https://';
};
