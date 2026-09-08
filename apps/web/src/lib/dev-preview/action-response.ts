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
  // The audit trail names the port for an approve — who agreed to share what
  // is the whole point of recording the act.
  const audited = action.kind === 'approve' || action.kind === 'select' ? { action: action.kind, port: action.port } : { action: action.kind };
  if (!result.ok) {
    if (result.reason === 'wake-not-allowed') {
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'dev_preview', resourceId, details: { route, ...audited, reason: 'wake_not_allowed', detail: result.detail }, riskScore: 0.5 });
      return NextResponse.json({ error: 'This drive cannot run code right now, so the preview cannot be switched back on', reason: result.detail }, { status: 403 });
    }
    // Neither of these is "there is nothing to switch", and answering 404
    // would tell the user their preview does not exist when it plainly does.
    if (result.reason === 'instance-changed') {
      return NextResponse.json({ error: 'This sandbox was rebuilt since the preview was shown. Check what is running and share it again.', reason: result.reason }, { status: 409 });
    }
    if (result.reason === 'port-changed') {
      return NextResponse.json({ error: 'The dev server has moved to a different port since this was shown. Check the port and share it again.', reason: result.reason }, { status: 409 });
    }
    // THE SELECT FAILURES, each a sentence a person can act on. This is the
    // "deliberate error instead of silence" the ports pane exists to give:
    // every one of these used to be indistinguishable from nothing happening.
    if (result.reason === 'sandbox-unavailable') {
      return NextResponse.json({ error: 'This sandbox is not running right now, so there is nothing to preview. Open a shell to start it, then pick the port again.', reason: result.reason }, { status: 409 });
    }
    if (result.reason === 'probe-failed') {
      const detail = result.detail === 'timed-out'
        ? 'The sandbox did not answer in time when asked which ports are listening.'
        : result.detail === 'unparsable'
          ? 'The sandbox answered, but its port listing could not be read.'
          : 'The sandbox could not be asked which ports are listening.';
      return NextResponse.json({ error: `${detail} Try Scan again.`, reason: result.reason, detail: result.detail }, { status: 503 });
    }
    if (result.reason === 'port-not-listening') {
      return NextResponse.json({ error: `Nothing is listening on port ${result.port} any more. Scan again to see what is running now.`, reason: result.reason, port: result.port }, { status: 409 });
    }
    if (result.reason === 'port-refused') {
      const why = result.detail === 'non-http-service-port'
        ? `Port ${result.port} looks like a database or service port, not a web server, so it is not shared.`
        : result.detail === 'relay-own-listener'
          ? `Port ${result.port} is the preview relay itself — pick the port your dev server is on.`
          : `Port ${result.port} cannot be previewed.`;
      auditRequest(request, { eventType: 'authz.access.denied', userId, resourceType: 'dev_preview', resourceId, details: { route, ...audited, reason: 'port_refused', detail: result.detail }, riskScore: 0.3 });
      return NextResponse.json({ error: why, reason: result.reason, port: result.port, detail: result.detail }, { status: 422 });
    }
    // `slot-unknown` IS NOT A FAILURE, and answering 4xx made the UI say it
    // was. The user's intent is already written — the resume cleared the stop,
    // the approval recorded the consent — and only the relay work deferred,
    // because no `ports/watch` snapshot proved 8080 free. That is precisely
    // the shape `lockContended` already reports as a success, and `post()`
    // THROWS on any 4xx, so the pane toasted "Could not switch the preview on"
    // over a click that had taken effect. Same status, same body shape, with
    // the deferral named so a caller can say "starting shortly" if it wants.
    if (result.reason === 'slot-unknown') {
      auditRequest(request, { eventType: 'data.write', userId, resourceType: 'dev_preview', resourceId, details: { route, ...audited, applied: null, deferred: 'awaiting-port-snapshot' } });
      return NextResponse.json({ ok: true, applied: null, deferred: 'awaiting-port-snapshot' });
    }
    return NextResponse.json(
      { error: holder.kind === 'env' ? 'This environment has no dev-server preview to switch' : 'This session has no dev-server preview to switch', reason: result.reason },
      { status: 404 },
    );
  }
  // A CONTENDED action is the same answer as `slot-unknown` and was left
  // silent one branch away from it: the intent landed, only the relay work
  // waits — here for the holder's lock rather than for a ports snapshot. The
  // pane only speaks when the body NAMES a deferral, so without a marker the
  // click produced nothing while the pane still read "not running". The two
  // markers stay distinct because the wait is not the same wait, and the copy
  // that explains it should not have to guess.
  const deferred = result.lockContended === true ? { deferred: 'awaiting-reconcile' as const } : {};
  auditRequest(request, { eventType: 'data.write', userId, resourceType: 'dev_preview', resourceId, details: { route, ...audited, applied: result.applied?.action ?? null, ...deferred } });
  return NextResponse.json({ ok: true, applied: result.applied, ...deferred });
}
