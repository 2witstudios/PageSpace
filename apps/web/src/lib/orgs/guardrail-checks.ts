export interface OrgGuardrails {
  allowedAIProviders: string[] | null;
  maxStorageBytes: number | null;
  maxAITokensPerDay: number | null;
  requireMFA: boolean;
  allowExternalSharing: boolean;
  allowedDomains: string[] | null;
}

export interface GuardrailCheckResult {
  allowed: boolean;
  reason?: string;
  orgId?: string;
}

export function checkAIProviderAllowed(
  guardrails: OrgGuardrails,
  provider: string
): GuardrailCheckResult {
  if (!guardrails.allowedAIProviders || guardrails.allowedAIProviders.length === 0) {
    return { allowed: true };
  }

  const allowed = guardrails.allowedAIProviders.includes(provider);
  return {
    allowed,
    reason: allowed ? undefined : `AI provider "${provider}" is not allowed by organization policy. Allowed: ${guardrails.allowedAIProviders.join(', ')}`,
  };
}

export function checkStorageLimit(
  guardrails: OrgGuardrails,
  currentUsageBytes: number,
  additionalBytes: number
): GuardrailCheckResult {
  if (guardrails.maxStorageBytes == null) {
    return { allowed: true };
  }

  const totalBytes = currentUsageBytes + additionalBytes;
  const allowed = totalBytes <= guardrails.maxStorageBytes;
  return {
    allowed,
    reason: allowed ? undefined : `Organization storage limit exceeded. Limit: ${formatBytes(guardrails.maxStorageBytes)}, Current: ${formatBytes(currentUsageBytes)}, Requested: ${formatBytes(additionalBytes)}`,
  };
}

export function checkAITokenLimit(
  guardrails: OrgGuardrails,
  currentTokensUsed: number
): GuardrailCheckResult {
  if (guardrails.maxAITokensPerDay == null) {
    return { allowed: true };
  }

  const allowed = currentTokensUsed < guardrails.maxAITokensPerDay;
  return {
    allowed,
    reason: allowed ? undefined : `Organization daily AI token limit reached (${guardrails.maxAITokensPerDay})`,
  };
}

export function checkExternalSharing(guardrails: OrgGuardrails): GuardrailCheckResult {
  return {
    allowed: guardrails.allowExternalSharing,
    reason: guardrails.allowExternalSharing ? undefined : 'External sharing is disabled by organization policy',
  };
}

export function checkDomainAllowed(
  guardrails: OrgGuardrails,
  email: string
): GuardrailCheckResult {
  if (!guardrails.allowedDomains || guardrails.allowedDomains.length === 0) {
    return { allowed: true };
  }

  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) {
    return { allowed: false, reason: 'Invalid email address' };
  }

  const allowed = guardrails.allowedDomains.some(
    (d) => d.toLowerCase() === domain
  );

  return {
    allowed,
    reason: allowed ? undefined : `Email domain "${domain}" is not allowed by organization policy. Allowed domains: ${guardrails.allowedDomains.join(', ')}`,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
