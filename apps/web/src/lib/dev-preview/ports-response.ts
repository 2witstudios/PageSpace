/**
 * The HTTP answer to the ports list (`POST …/preview/ports`), shared by the
 * session and env routes so status codes and copy cannot drift. Failures use
 * the same sentences as the select action's, because they are the same
 * failures.
 */

import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { DevPreviewHolderRef } from '@pagespace/lib/services/sandbox/preview/dev-preview-core';
import type { DevPreviewPortsResult } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { describeProbeFailure } from './action-response';

export function respondToDevPreviewPorts({
  request,
  userId,
  route,
  holder,
  result,
}: {
  request: Request;
  userId: string;
  route: string;
  holder: DevPreviewHolderRef;
  result: DevPreviewPortsResult;
}): NextResponse {
  const resourceId = `${holder.kind}:${holder.id}`;
  if (!result.ok) {
    if (result.reason === 'wake-not-allowed') {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'dev_preview', resourceId, details: { route, action: 'ports', reason: 'wake_not_allowed', detail: result.detail }, riskScore: 0.5 });
      return NextResponse.json({ error: 'This drive cannot run code right now, so the sandbox cannot be asked which ports are listening.', reason: result.detail }, { status: 403 });
    }
    if (result.reason === 'sandbox-unavailable') {
      return NextResponse.json({ error: 'This sandbox is not running right now, so there are no ports to list. Open a shell to start it, then Scan again.', reason: result.reason }, { status: 409 });
    }
    return NextResponse.json({ error: `${describeProbeFailure(result.detail)} Try Scan again.`, reason: result.reason, detail: result.detail }, { status: 503 });
  }
  // A probe is an exec, and an exec can be a billed wake: worth a row.
  auditRequest(request, { eventType: 'data.read', userId, resourceType: 'dev_preview', resourceId, details: { route, action: 'ports', ports: result.ports.length } });
  return NextResponse.json({ ok: true, spriteInstanceId: result.spriteInstanceId, ports: result.ports, currentPort: result.currentPort });
}
