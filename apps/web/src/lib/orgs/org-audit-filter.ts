import type { OrgAuditFilterInput } from '@pagespace/lib/audit/org-audit-query-core';

/** The org audit log's query string (AUD-3); validation is lib's parseOrgAuditFilter. */
export const orgAuditFilterInput = (url: URL): OrgAuditFilterInput => ({
  type: url.searchParams.get('type'),
  category: url.searchParams.get('category'),
  driveId: url.searchParams.get('driveId'),
  from: url.searchParams.get('from'),
  to: url.searchParams.get('to'),
  limit: url.searchParams.get('limit'),
  before: url.searchParams.get('before'),
});
