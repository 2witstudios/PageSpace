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
