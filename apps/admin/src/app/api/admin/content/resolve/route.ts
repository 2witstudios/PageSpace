import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listCasesForTarget } from '@pagespace/lib/content-safety/case-store';
import { resolveTakedownTarget } from '@pagespace/lib/content-safety/targets';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { toCaseSummary } from '@/lib/content/case-summary';

/**
 * GET /api/admin/content/resolve?q=<hash | file ID | page ID | published URL | user ID>
 *
 * Resolve what the admin typed to a takedown target, with everything that
 * references it and the case history.
 *
 * METADATA ONLY. The response carries IDs, a MIME type and flags — never a
 * title, a filename, a preview, a thumbnail or any URL to the file. An admin
 * must be able to act on suspected CSAM without ever being shown it.
 */
export const GET = withAdminAuth(async (adminUser, request) => {
  const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (!query || query.length > 2048) {
    return NextResponse.json({ error: 'Enter a content hash, file ID, page ID, published URL or user ID' }, { status: 400 });
  }

  try {
    const target = await resolveTakedownTarget(query);

    auditRequest(request, {
      eventType: 'content.case.read',
      userId: adminUser.id,
      resourceType: target?.targetType ?? 'content_lookup',
      // The resolved ID, never the raw query: a pasted URL does not belong in the audit log.
      resourceId: target?.targetId ?? 'not_found',
      details: { source: 'admin', action: 'resolve', found: target !== null },
    });

    if (!target) return NextResponse.json({ error: 'Nothing matches that input' }, { status: 404 });

    const cases = await listCasesForTarget({
      targetType: target.targetType,
      targetId: target.targetId,
      contentHash: target.contentHash,
    });
    return NextResponse.json({ target, cases: cases.map(toCaseSummary) });
  } catch (error) {
    loggers.api.error('Error resolving content target', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to resolve target' }, { status: 500 });
  }
});
