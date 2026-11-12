import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { security: { warn: vi.fn(), error: vi.fn() } },
}));

import { callWebTakedown } from '../web-takedown';

const REQUEST = { action: 'resume', caseId: 'case-1' } as const;
const fetchMock = vi.fn();

describe('callWebTakedown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WEB_APP_INTERNAL_URL', 'http://web:3000');
    vi.stubEnv('SERVICE_API_SECRET', 'a-service-secret');
    fetchMock.mockResolvedValue(Response.json({ action: 'resume', caseId: 'case-1', status: 'actioned' }));
  });

  it('posts the request to the web app with the service secret and the acting admin', async () => {
    const result = await callWebTakedown(REQUEST, 'admin-1');

    expect(result).toEqual({ ok: true, status: 200, body: { action: 'resume', caseId: 'case-1', status: 'actioned' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://web:3000/api/internal/content-safety/takedown');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-service-secret': 'a-service-secret', 'x-service-user-id': 'admin-1' });
    expect(JSON.parse(init.body)).toEqual(REQUEST);
  });

  it('answers 503 without calling out when the proxy is not configured', async () => {
    vi.stubEnv('SERVICE_API_SECRET', '');
    const result = await callWebTakedown(REQUEST, 'admin-1');

    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes on the web app\'s refusal with its status and message', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Case not found' }, { status: 404 }));
    expect(await callWebTakedown(REQUEST, 'admin-1')).toEqual({ ok: false, status: 404, error: 'Case not found' });
  });

  it('answers 502 and warns the takedown may not have run when the web app cannot be reached', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await callWebTakedown(REQUEST, 'admin-1');

    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(result.ok === false && result.error).toContain('check the case list');
  });

  it('treats a success with no readable body as a failure', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    expect(await callWebTakedown(REQUEST, 'admin-1')).toMatchObject({ ok: false, status: 502 });
  });
});
