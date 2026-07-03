import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildRequest } from '../build-request.js';
import type { ClientConfig, TransportOperation } from '../types.js';

const config: ClientConfig = { baseUrl: 'https://pagespace.ai' };

function op(overrides: Partial<TransportOperation> = {}): TransportOperation {
  return {
    name: 'test.op',
    method: 'GET',
    path: '/api/widgets',
    outputSchema: z.object({ ok: z.boolean() }),
    ...overrides,
  };
}

describe('buildRequest — path interpolation', () => {
  it('interpolates a single path param', () => {
    const request = buildRequest(op({ path: '/api/drives/:driveId' }), { driveId: 'abc123' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives/abc123');
  });

  it('interpolates multiple path params', () => {
    const request = buildRequest(
      op({ path: '/api/drives/:driveId/pages/:pageId' }),
      { driveId: 'd1', pageId: 'p1' },
      config,
    );
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1/pages/p1');
  });

  it('URL-encodes a path param containing a literal slash', () => {
    const request = buildRequest(op({ path: '/api/drives/:driveId' }), { driveId: 'a/b' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives/a%2Fb');
  });

  it('URL-encodes unicode in a path param', () => {
    const request = buildRequest(op({ path: '/api/drives/:driveId' }), { driveId: '日本語' }, config);
    expect(request.url).toBe(`https://pagespace.ai/api/drives/${encodeURIComponent('日本語')}`);
  });

  it('interpolates an empty-string path param without throwing', () => {
    const request = buildRequest(op({ path: '/api/drives/:driveId' }), { driveId: '' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/drives/');
  });

  it('throws when a required path param is missing from input', () => {
    expect(() => buildRequest(op({ path: '/api/drives/:driveId' }), {}, config)).toThrow();
  });
});

describe('buildRequest — query serialization', () => {
  it('serializes remaining GET input fields as a query string in deterministic (sorted) key order', () => {
    const request = buildRequest(op({ path: '/api/pages' }), { zeta: '1', alpha: '2', mid: '3' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/pages?alpha=2&mid=3&zeta=1');
  });

  it('produces the same query string regardless of input key insertion order', () => {
    const a = buildRequest(op({ path: '/api/pages' }), { b: '2', a: '1' }, config);
    const b = buildRequest(op({ path: '/api/pages' }), { a: '1', b: '2' }, config);
    expect(a.url).toBe(b.url);
  });

  it('omits path params from the query string', () => {
    const request = buildRequest(
      op({ path: '/api/drives/:driveId/pages' }),
      { driveId: 'd1', recursive: true },
      config,
    );
    expect(request.url).toBe('https://pagespace.ai/api/drives/d1/pages?recursive=true');
  });

  it('drops undefined/null query fields', () => {
    const request = buildRequest(
      op({ path: '/api/pages' }),
      { parentId: undefined, recursive: null, ls: true },
      config,
    );
    expect(request.url).toBe('https://pagespace.ai/api/pages?ls=true');
  });

  it('repeats a query key for array values', () => {
    const request = buildRequest(op({ path: '/api/pages' }), { tag: ['a', 'b'] }, config);
    expect(request.url).toBe('https://pagespace.ai/api/pages?tag=a&tag=b');
  });

  it('produces no trailing "?" when there are no remaining fields', () => {
    const request = buildRequest(op({ path: '/api/pages' }), {}, config);
    expect(request.url).toBe('https://pagespace.ai/api/pages');
  });
});

describe('buildRequest — body and Content-Type', () => {
  it('sends remaining fields as a JSON body for non-GET methods', () => {
    const request = buildRequest(op({ method: 'POST', path: '/api/pages' }), { title: 'Hi', driveId: 'd1' }, config);
    expect(request.body).toBe(JSON.stringify({ driveId: 'd1', title: 'Hi' }));
  });

  it('sets Content-Type only when a body is present', () => {
    const withBody = buildRequest(op({ method: 'POST', path: '/api/pages' }), { title: 'Hi' }, config);
    expect(withBody.headers['Content-Type']).toBe('application/json');

    const withoutBody = buildRequest(op({ method: 'DELETE', path: '/api/pages/:id' }), { id: 'p1' }, config);
    expect(withoutBody.headers['Content-Type']).toBeUndefined();
    expect(withoutBody.body).toBeUndefined();
  });

  it('never puts remaining fields into the query string for non-GET methods', () => {
    const request = buildRequest(op({ method: 'PATCH', path: '/api/pages/:id' }), { id: 'p1', title: 'Hi' }, config);
    expect(request.url).toBe('https://pagespace.ai/api/pages/p1');
  });

  it('preserves nested object fields (sorted-key ordering must not act as a stringify replacer filter)', () => {
    const request = buildRequest(
      op({ method: 'POST', path: '/api/pages' }),
      { cells: [{ address: 'A1', value: '=SUM(B1:B2)' }] },
      config,
    );
    expect(JSON.parse(request.body!)).toEqual({ cells: [{ address: 'A1', value: '=SUM(B1:B2)' }] });
  });
});

describe('buildRequest — version header (ADR 0001)', () => {
  it('attaches X-PageSpace-API-Version defaulting to MIN_SERVER_API_VERSION', () => {
    const request = buildRequest(op(), {}, config);
    expect(request.headers['X-PageSpace-API-Version']).toBe('1.0.0');
  });

  it('honors an explicit config.apiVersion override', () => {
    const request = buildRequest(op(), {}, { baseUrl: 'https://pagespace.ai', apiVersion: '1.4.2' });
    expect(request.headers['X-PageSpace-API-Version']).toBe('1.4.2');
  });
});

describe('buildRequest — no token in ClientConfig', () => {
  it('ClientConfig has no token field; Authorization is attached by the facade (task 6), never here', () => {
    // @ts-expect-error ClientConfig must never accept a token/credential field.
    const withToken: ClientConfig = { baseUrl: 'https://pagespace.ai', token: 'ps_sess_x' };
    expect(withToken).toBeDefined();
  });

  it('never emits an Authorization header itself', () => {
    const request = buildRequest(op(), {}, config);
    expect(Object.keys(request.headers)).not.toContain('Authorization');
  });
});
