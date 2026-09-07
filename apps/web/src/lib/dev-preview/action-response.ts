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
    // `slot-unknown` IS NOT A FAILURE, and answering 4xx made the UI say it
    // was. The user's intent is already written — the resume cleared the stop
    // — and only the relay work deferred, because no `ports/watch` snapshot
    // proved 8080 free; the detector's next frame starts it against a real
    // snapshot. `post()` THROWS on any 4xx, so the pane toasted "Could not
    // switch the preview on" over a click that had taken effect. It is
    // therefore the same success shape an attach-less action already returns
    // (`applied: null`), with the deferral named so a caller can say
    // "starting shortly" if it wants.
    if (result.reason === 'slot-unknown') {
      auditRequest(request, { eventType: 'data.write', userId, resourceType: 'dev_preview', resourceId, details: { route, action, applied: null, deferred: 'awaiting-port-snapshot' } });
      return NextResponse.json({ ok: true, applied: null, deferred: 'awaiting-port-snapshot' });
    }
    return NextResponse.json(
      { error: holder.kind === 'env' ? 'This environment has no dev-server preview to switch' : 'This session has no dev-server preview to switch', reason: result.reason },
      { status: 404 },
    );
  }
  auditRequest(request, { eventType: 'data.write', userId, resourceType: 'dev_preview', resourceId, details: { route, action, applied: result.applied?.action ?? null } });
  return NextResponse.json({ ok: true, applied: result.applied });
}
