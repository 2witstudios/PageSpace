import { describe, it, expect } from 'vitest';
import { validateTerminalConnectPayload, clampTerminalDimensions, parseShellConnectPayload } from '../validation';

describe('validateTerminalConnectPayload', () => {
  it('given a valid payload, should return ok:true with typed value', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc123', cols: 80, rows: 24 });
    expect(result).toEqual({ ok: true, value: { pageId: 'abc123', cols: 80, rows: 24 } });
  });

  it('given null payload, should return ok:false', () => {
    const result = validateTerminalConnectPayload(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid payload');
  });

  it('given a non-object payload, should return ok:false', () => {
    const result = validateTerminalConnectPayload('hello');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid payload');
  });

  it('given pageId is missing, should return ok:false with invalid pageId', () => {
    const result = validateTerminalConnectPayload({ cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid pageId');
  });

  it('given pageId is empty string, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: '', cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid pageId');
  });

  it('given pageId is a number, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 42, cols: 80, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid pageId');
  });

  it('given cols is missing, should return ok:false with invalid cols', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given cols is zero, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: 0, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given cols is negative, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: -1, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given cols is a string, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: '80', rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given cols is NaN, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: NaN, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given cols is Infinity, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: Infinity, rows: 24 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given rows is NaN, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: 80, rows: NaN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid rows');
  });

  it('given rows is Infinity, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: 80, rows: Infinity });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid rows');
  });

  it('given rows is missing, should return ok:false with invalid rows', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: 80 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid rows');
  });

  it('given rows is zero, should return ok:false', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: 80, rows: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid rows');
  });

  it('given extra unknown fields, should ignore them and return ok:true', () => {
    const result = validateTerminalConnectPayload({ pageId: 'abc', cols: 80, rows: 24, extra: 'ignored' });
    expect(result).toEqual({ ok: true, value: { pageId: 'abc', cols: 80, rows: 24 } });
  });
});

describe('clampTerminalDimensions', () => {
  it('given normal dimensions, should return unchanged', () => {
    expect(clampTerminalDimensions({ cols: 80, rows: 24 })).toEqual({ cols: 80, rows: 24 });
  });

  it('given cols < 10, should clamp to 10', () => {
    expect(clampTerminalDimensions({ cols: 3, rows: 24 })).toEqual({ cols: 10, rows: 24 });
  });

  it('given rows < 5, should clamp to 5', () => {
    expect(clampTerminalDimensions({ cols: 80, rows: 2 })).toEqual({ cols: 80, rows: 5 });
  });

  it('given cols > 500, should clamp to 500', () => {
    expect(clampTerminalDimensions({ cols: 9999, rows: 24 })).toEqual({ cols: 500, rows: 24 });
  });

  it('given rows > 200, should clamp to 200', () => {
    expect(clampTerminalDimensions({ cols: 80, rows: 999 })).toEqual({ cols: 80, rows: 200 });
  });

  it('given float cols, should floor to integer', () => {
    expect(clampTerminalDimensions({ cols: 80.7, rows: 24.9 })).toEqual({ cols: 80, rows: 24 });
  });

  it('given both at minimums, should return minimums', () => {
    expect(clampTerminalDimensions({ cols: 0, rows: 0 })).toEqual({ cols: 10, rows: 5 });
  });
});

describe('parseShellConnectPayload — the SHARED contract schema', () => {
  it('given a valid payload, should parse and pass the dimensions through', () => {
    const result = parseShellConnectPayload({ shellId: 'shl-1', cols: 80, rows: 24 });
    expect(result).toEqual({ ok: true, value: { shellId: 'shl-1', cols: 80, rows: 24 } });
  });

  it('given out-of-range dimensions, should CLAMP them on parse — a caller never has to remember to', () => {
    const result = parseShellConnectPayload({ shellId: 'shl-1', cols: 9999, rows: 2 });
    expect(result).toEqual({ ok: true, value: { shellId: 'shl-1', cols: 500, rows: 5 } });
  });

  it('given nonsense dimensions (zero, negative, non-finite, non-numeric), should REJECT rather than clamp', () => {
    const results = [
      parseShellConnectPayload({ shellId: 'shl-1', cols: 0, rows: 24 }),
      parseShellConnectPayload({ shellId: 'shl-1', cols: 80, rows: -1 }),
      parseShellConnectPayload({ shellId: 'shl-1', cols: Infinity, rows: 24 }),
      parseShellConnectPayload({ shellId: 'shl-1', cols: '80', rows: 24 }),
    ];
    expect(results.every((r) => r.ok === false)).toBe(true);
  });

  it('given a missing shellId, should reject naming the field', () => {
    const result = parseShellConnectPayload({ cols: 80, rows: 24 });
    expect(result).toEqual({ ok: false, error: 'invalid shellId' });
  });

  it('given a null payload, should reject with a payload-level error', () => {
    const result = parseShellConnectPayload(null);
    expect(result.ok).toBe(false);
  });

  it('given an optional connectionId, should carry it through', () => {
    const result = parseShellConnectPayload({ shellId: 'shl-1', cols: 80, rows: 24, connectionId: 'pane-a' });
    expect(result).toEqual({ ok: true, value: { shellId: 'shl-1', cols: 80, rows: 24, connectionId: 'pane-a' } });
  });

  it('given unknown extra keys (a stale client field), should STRIP them rather than reject — a session-binding field cannot sneak in', () => {
    const result = parseShellConnectPayload({ shellId: 'shl-1', cols: 80, rows: 24, machineId: 'm1', sessionBinding: 'x' });
    expect(result).toEqual({ ok: true, value: { shellId: 'shl-1', cols: 80, rows: 24 } });
  });
});
