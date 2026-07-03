import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  isAuthenticationError,
  isNotFoundError,
  isResponseValidationError,
  isServerError,
  PageSpaceError,
} from '../../errors.js';
import { parseResponse } from '../parse-response.js';
import type { TransportOperation } from '../types.js';

const widgetOp: TransportOperation<{ id: string; ok: boolean }> = {
  name: 'widgets.get',
  method: 'GET',
  path: '/api/widgets/:id',
  outputSchema: z.object({ id: z.string(), ok: z.boolean() }),
};

const exportOp: TransportOperation<string> = {
  name: 'pages.export',
  method: 'GET',
  path: '/api/pages/:id/export',
  outputSchema: z.string(),
  textResponse: true,
};

describe('parseResponse — success path', () => {
  it('returns the zod-validated output on a 2xx response matching the schema', () => {
    const result = parseResponse(widgetOp, 200, {}, JSON.stringify({ id: 'w1', ok: true }));
    expect(result).toEqual({ id: 'w1', ok: true });
  });

  it('passes 2xx bodyText through unparsed for textResponse operations', () => {
    const result = parseResponse(exportOp, 200, {}, 'plain export text, not json {[');
    expect(result).toBe('plain export text, not json {[');
  });
});

describe('parseResponse — response drift', () => {
  it('returns ResponseValidationError when the 2xx body does not match the output schema', () => {
    const result = parseResponse(widgetOp, 200, {}, JSON.stringify({ id: 'w1', ok: 'not-a-boolean' }));
    expect(result).toBeInstanceOf(PageSpaceError);
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('never throws on malformed JSON in a 2xx body — returns ResponseValidationError instead', () => {
    expect(() => parseResponse(widgetOp, 200, {}, '{not valid json')).not.toThrow();
    const result = parseResponse(widgetOp, 200, {}, '{not valid json');
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('never throws on an empty 2xx body when the schema requires content', () => {
    expect(() => parseResponse(widgetOp, 200, {}, '')).not.toThrow();
    const result = parseResponse(widgetOp, 200, {}, '');
    expect(isResponseValidationError(result)).toBe(true);
  });

  it('names the operation on the ResponseValidationError', () => {
    const result = parseResponse(widgetOp, 200, {}, JSON.stringify({ id: 'w1' }));
    expect(result).toBeInstanceOf(Error);
    expect((result as Error & { operation?: string }).operation).toBe('widgets.get');
  });
});

describe('parseResponse — non-2xx classification', () => {
  it('classifies a 404 via task 2 classifyHttpError', () => {
    const result = parseResponse(widgetOp, 404, {}, JSON.stringify({ error: 'not found' }));
    expect(isNotFoundError(result)).toBe(true);
  });

  it('classifies a 401 via task 2 classifyHttpError', () => {
    const result = parseResponse(widgetOp, 401, {}, JSON.stringify({ error: 'nope' }));
    expect(isAuthenticationError(result)).toBe(true);
  });

  it('classifies a 500 via task 2 classifyHttpError, even with an unparseable body', () => {
    const result = parseResponse(widgetOp, 500, {}, '<html>Internal Server Error</html>');
    expect(isServerError(result)).toBe(true);
  });

  it('classifies non-2xx even for textResponse operations (does not pass errors through as text)', () => {
    const result = parseResponse(exportOp, 404, {}, JSON.stringify({ error: 'gone' }));
    expect(isNotFoundError(result)).toBe(true);
  });
});

describe('parseResponse — never throws on junk', () => {
  it('handles arbitrary garbage bodies across statuses without throwing', () => {
    const garbageBodies = ['', 'null', 'undefined', '<xml/>', '{"a":', '[1,2,3', String.fromCharCode(0)];
    const statuses = [200, 201, 400, 404, 500];
    for (const status of statuses) {
      for (const body of garbageBodies) {
        expect(() => parseResponse(widgetOp, status, {}, body)).not.toThrow();
      }
    }
  });
});
