import { describe, it, expect } from 'vitest';
import { validateResponse } from './validate-response';

describe('validateResponse', () => {
  it('given no validation config, should return valid', () => {
    expect(validateResponse({ ok: false })).toEqual({ valid: true });
  });

  it('given matching success value, should return valid', () => {
    const result = validateResponse(
      { ok: true },
      { success: { path: '$.ok', equals: true }, errorPath: '$.error' }
    );

    expect(result).toEqual({ valid: true });
  });

  it('given provider error string, should return invalid with provider error', () => {
    const result = validateResponse(
      { ok: false, error: 'missing_scope' },
      { success: { path: '$.ok', equals: true }, errorPath: '$.error' }
    );

    expect(result).toEqual({ valid: false, error: 'missing_scope' });
  });

  it('given mismatch without provider error, should return generic invalid error', () => {
    const result = validateResponse(
      { ok: false },
      { success: { path: '$.ok', equals: true }, errorPath: '$.error' }
    );

    expect(result).toEqual({
      valid: false,
      error: 'Provider response indicated failure',
    });
  });
});
