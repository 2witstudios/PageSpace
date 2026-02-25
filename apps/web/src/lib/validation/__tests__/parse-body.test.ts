import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { safeParseBody } from '../parse-body';

const testSchema = z.object({
  name: z.string().min(1),
  count: z.number().positive().optional(),
});

function makeRequest(body: string, contentType = 'application/json') {
  return new Request('http://localhost/test', {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
}

describe('safeParseBody', () => {
  it('given valid JSON matching schema, should return success with parsed data', async () => {
    const request = makeRequest(JSON.stringify({ name: 'test', count: 5 }));
    const result = await safeParseBody(request, testSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'test', count: 5 });
    }
  });

  it('given malformed JSON, should return 400 with error message', async () => {
    const request = makeRequest('not valid json{{{');
    const result = await safeParseBody(request, testSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(body.error).toBe('Invalid JSON body');
    }
  });

  it('given valid JSON that fails schema validation, should return 400 with string error', async () => {
    const request = makeRequest(JSON.stringify({ name: '', count: -1 }));
    const result = await safeParseBody(request, testSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
      const body = await result.response.json();
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
    }
  });

  it('given empty body, should return 400 for invalid JSON', async () => {
    const request = makeRequest('');
    const result = await safeParseBody(request, testSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(400);
    }
  });

  it('given valid JSON with extra fields, should strip them per schema', async () => {
    const request = makeRequest(JSON.stringify({ name: 'hello', extra: 'field' }));
    const result = await safeParseBody(request, testSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('hello');
      expect((result.data as Record<string, unknown>).extra).toBeUndefined();
    }
  });
});
