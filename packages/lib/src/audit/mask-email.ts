/**
 * Mask an email for PII-safe logging (e.g., john@example.com -> jo***@example.com).
 *
 * The domain is intentionally retained. Operational debugging of auth flows
 * (OAuth provider mismatches, email deliverability, tenant-scoped issues)
 * requires knowing which provider/domain the user came from. The local part
 * is the uniquely identifying component and is the one we truncate.
 *
 * Kept as a zero-import leaf module so test mocks can pull the real
 * implementation via `vi.importActual('@pagespace/lib/audit/mask-email')`
 * without dragging in the DB-bound audit service.
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***@***';
  const visibleChars = Math.min(2, local.length);
  return `${local.slice(0, visibleChars)}***@${domain}`;
}
