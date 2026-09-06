/**
 * The HTTP answer to a dev-preview user action, shared by the session and
 * env action routes so the status codes, the copy and the audit rows cannot
 * drift between the two holders.
 */

import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import type { DevPreviewUserAction, DevPreviewUserActionResult } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';

export function respondToDevPreviewUserAction({
  request,
  userId,
  route,
  holder,
  action,
  result,
}: {
  request: Request;
  userId: string;
  route: string;
  holder: DevPreviewHolderRef;
  action: DevPreviewUserAction;
  result: DevPreviewUserActionResult;
}): NextResponse {
  const resourceId = `${holder.kind}:${holder.id}`;
  if (!result.ok) {
    if (result.reason === 'wake-not-allowed') {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'dev_preview', resourceId, details: { route, action, reason: 'wake_not_allowed', detail: result.detail }, riskScore: 0.5 });
      return NextResponse.json({ error: 'This drive cannot run code right now, so the preview cannot be switched back on', reason: result.detail }, { status: 403 });
    }
    return NextResponse.json(
      { error: holder.kind === 'env' ? 'This environment has no dev-server preview to switch' : 'This session has no dev-server preview to switch', reason: result.reason },
      { status: 404 },
    );
  }
  auditRequest(request, { eventType: 'data.write', userId, resourceType: 'dev_preview', resourceId, details: { route, action, applied: result.applied?.action ?? null } });
  return NextResponse.json({ ok: true, applied: result.applied });
}
