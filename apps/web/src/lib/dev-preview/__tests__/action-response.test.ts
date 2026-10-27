/**
 * The shared HTTP answer to a dev-preview user action. The one thing this
 * module must never do is call an accepted action a failure: `post()` throws
 * on any 4xx, so a status code chosen here becomes a red toast in the pane.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

import { auditRequest } from '@pagespace/lib/audit/audit-log';
import type { DevPreviewUserActionResult } from '@pagespace/lib/services/sandbox/preview/dev-preview-status';
import { respondToDevPreviewUserAction } from '../action-response';

const ENV = { kind: 'env', id: 'env1' } as const;
const WS = { kind: 'workspace', id: 'ws1' } as const;

const respond = (result: DevPreviewUserActionResult, holder: typeof ENV | typeof WS = ENV) =>
  respondToDevPreviewUserAction({
    request: new Request('https://app.test/api/x', { method: 'POST' }),
    userId: 'u1',
    route: 'POST /api/x',
    holder,
    action: { kind: 'resume' },
    result,
  });

beforeEach(() => vi.mocked(auditRequest).mockClear());

describe('respondToDevPreviewUserAction', () => {
  it('an applied action is 200 with what was applied', async () => {
    const res = respond({ ok: true, applied: { action: 'start-relay' } as never });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: { action: 'start-relay' } });
  });

  it('a CONTENDED action names its deferral too — the same silence, one branch over', () => {
    // `lockContended` is documented as the same shape as `slot-unknown`: the
    // intent landed, only the relay work waits. It was dropping the marker,
    // so the pane — which speaks only when the body names one — said nothing
    // over a click that had taken effect.
    const res = respond({ ok: true, applied: null, lockContended: true });
    expect(res.status).toBe(200);
    return res.json().then((body: unknown) => {
      expect(body).toEqual({ ok: true, applied: null, deferred: 'awaiting-reconcile' });
      expect(vi.mocked(auditRequest).mock.calls[0]?.[1]).toMatchObject({
        details: { route: 'POST /api/x', action: 'resume', applied: null, deferred: 'awaiting-reconcile' },
      });
    });
  });

  it('an UNCONTENDED success carries no deferral marker, so the pane stays quiet', async () => {
    const res = respond({ ok: true, applied: null });
    expect(await res.json()).toEqual({ ok: true, applied: null });
  });

  it('slot-unknown is a DEFERRAL, not a failure: 200, ok:true, and the deferral named', async () => {
    const res = respond({ ok: false, reason: 'slot-unknown' });
    // The intent is already written — the resume cleared the stop — and only
    // the relay start waits for a real `ports/watch` snapshot. A 4xx here made
    // `post()` throw and the pane toast "Could not switch the preview on" over
    // a click that had taken effect.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: null, deferred: 'awaiting-port-snapshot' });
    expect(vi.mocked(auditRequest).mock.calls[0]?.[1]).toMatchObject({
      eventType: 'data.write',
      resourceId: 'env:env1',
      details: { route: 'POST /api/x', action: 'resume', applied: null, deferred: 'awaiting-port-snapshot' },
    });
  });

  it('no-preview is still a 404 naming the holder kind, and writes no data.write row', async () => {
    const env = respond({ ok: false, reason: 'no-preview' });
    expect(env.status).toBe(404);
    expect((await env.json()).error).toContain('environment');
    const ws = respond({ ok: false, reason: 'no-preview' }, WS);
    expect(ws.status).toBe(404);
    expect((await ws.json()).error).toContain('session');
    expect(vi.mocked(auditRequest).mock.calls.map((c) => c[1].eventType)).not.toContain('data.write');
  });

  it('a refused wake is 403 with the denial audited', async () => {
    const res = respond({ ok: false, reason: 'wake-not-allowed', detail: 'no_credits' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining('cannot run code'), reason: 'no_credits' });
    expect(vi.mocked(auditRequest).mock.calls[0]?.[1]).toMatchObject({ eventType: 'authz.access.denied', riskScore: 0.5 });
  });
});

describe('the select failures each get a sentence a person can act on', () => {
  const selectAction = { kind: 'select' as const, port: 3000, spriteInstanceId: 'inst' };
  const respondSelect = (result: DevPreviewUserActionResult) =>
    respondToDevPreviewUserAction({
      request: new Request('https://app.test/api/x', { method: 'POST' }),
      userId: 'u1',
      route: 'POST /api/x',
      holder: ENV,
      action: selectAction,
      result,
    });

  it('sandbox-unavailable is a 409 that says how to fix it', async () => {
    const res = respondSelect({ ok: false, reason: 'sandbox-unavailable' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Open a shell');
  });

  it('probe-failed is a 503 that names WHICH way the look failed, and invites a rescan', async () => {
    const res = respondSelect({ ok: false, reason: 'probe-failed', detail: 'timed-out' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('did not answer in time');
    expect(body.error).toContain('Scan again');
    expect(body.detail).toBe('timed-out');
  });

  it('port-not-listening is a 409 naming the port', async () => {
    const res = respondSelect({ ok: false, reason: 'port-not-listening', port: 3000 });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('port 3000');
  });

  it('port-refused is a 422 that explains WHY, and is audited as a denial', async () => {
    const db = respondSelect({ ok: false, reason: 'port-refused', port: 5432, detail: 'non-http-service-port' });
    expect(db.status).toBe(422);
    expect((await db.json()).error).toContain('database');
    expect(vi.mocked(auditRequest).mock.calls.at(-1)?.[1]).toMatchObject({ eventType: 'authz.access.denied', details: { action: 'select', port: 3000, reason: 'port_refused', detail: 'non-http-service-port' } });

    const relay = respondSelect({ ok: false, reason: 'port-refused', port: 8080, detail: 'relay-own-listener' });
    expect((await relay.json()).error).toContain('relay itself');
  });

  it('a successful select audits the port it selected, like approve does', async () => {
    const res = respondSelect({ ok: true, applied: null });
    expect(res.status).toBe(200);
    expect(vi.mocked(auditRequest).mock.calls.at(-1)?.[1]).toMatchObject({ eventType: 'data.write', details: { action: 'select', port: 3000 } });
  });
});
