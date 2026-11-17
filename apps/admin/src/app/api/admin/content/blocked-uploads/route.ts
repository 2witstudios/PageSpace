import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { queryAuditEvents } from '@pagespace/lib/audit/audit-query';
import { normalizeContentHash } from '@pagespace/lib/content-safety/policy';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

/**
 * GET /api/admin/content/blocked-uploads[?hash=<sha256>&limit=]
 *
 * Attempts to store, attach or copy blocklisted content, read from the
 * `content.upload.blocked` audit events the upload gates write (PR 1). Shows
 * who tried, when and through which entry point — who is trying to bring
 * blocked content back.
 *
 * Reads the audit log through the resolved audit binding, so it works whether
 * the log lives in the main database or the dedicated admin one.
 */

/** IDs the gates attach to the event. Anything else in `details` is not passed on. */
const DETAIL_KEYS = ['entryPoint', 'reason', 'driveId', 'pageId', 'conversationId', 'targetId'] as const;

export const GET = withAdminAuth(async (adminUser, request) => {
  try {
    const params = new URL(request.url).searchParams;
    const hashParam = params.get('hash')?.trim();
    const hash = hashParam ? normalizeContentHash(hashParam) : null;
    if (hashParam && !hash) {
      return NextResponse.json({ error: 'Filter must be a sha256 content hash' }, { status: 400 });
    }
    const limit = parseBoundedIntParam(params.get('limit'), { defaultValue: 100, min: 1, max: 500 });

    const events = await queryAuditEvents({
      eventType: 'content.upload.blocked',
      ...(hash ? { resourceId: hash } : {}),
      limit,
    });

    // This lists who tried to upload blocked content, so reading it is audited like its sibling routes.
    auditRequest(request, {
      eventType: 'content.case.read',
      userId: adminUser.id,
      resourceType: 'content_blocked_uploads',
      resourceId: hash ?? 'list',
      details: { source: 'admin', action: 'list_blocked_uploads', filtered: hash !== null, count: events.length },
    });

    return NextResponse.json({
      attempts: events.map((event) => {
        const details = (event.details ?? {}) as Record<string, unknown>;
        const picked: Record<string, string> = {};
        for (const key of DETAIL_KEYS) {
          const value = details[key];
          if (typeof value === 'string') picked[key] = value;
        }
        return {
          id: event.id,
          timestamp: event.timestamp.toISOString(),
          userId: event.userId,
          // A blocklist hit names the hash; an unverifiable reference names the page or file instead.
          resourceType: event.resourceType,
          resourceId: event.resourceId,
          ...picked,
        };
      }),
      limit,
    });
  } catch (error) {
    loggers.api.error('Error listing blocked uploads', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to list blocked uploads' }, { status: 500 });
  }
});
