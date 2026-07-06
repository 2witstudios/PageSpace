import { describe, it, expect } from 'vitest';
import { validateTerminalConnectPayload, validateAgentTerminalConnectPayload, clampTerminalDimensions } from '../validation';

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

describe('validateAgentTerminalConnectPayload', () => {
  const valid = { terminalId: 't1', projectName: 'repo', branchName: 'feature-x', name: 'cli', cols: 80, rows: 24 };

  it('given a valid payload, should return ok:true with typed value', () => {
    expect(validateAgentTerminalConnectPayload(valid)).toEqual({ ok: true, value: valid });
  });

  it('given null payload, should return ok:false', () => {
    const result = validateAgentTerminalConnectPayload(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid payload');
  });

  for (const field of ['terminalId', 'projectName', 'branchName', 'name']) {
    it(`given ${field} is missing, should return ok:false`, () => {
      const { [field]: _omit, ...rest } = valid;
      const result = validateAgentTerminalConnectPayload(rest);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(`invalid ${field}`);
    });

    it(`given ${field} is an empty string, should return ok:false`, () => {
      const result = validateAgentTerminalConnectPayload({ ...valid, [field]: '' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(`invalid ${field}`);
    });
  }

  it('given cols is invalid, should return ok:false', () => {
    const result = validateAgentTerminalConnectPayload({ ...valid, cols: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid cols');
  });

  it('given rows is invalid, should return ok:false', () => {
    const result = validateAgentTerminalConnectPayload({ ...valid, rows: NaN });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('invalid rows');
  });

  it('given extra unknown fields, should ignore them and return ok:true', () => {
    const result = validateAgentTerminalConnectPayload({ ...valid, extra: 'ignored' });
    expect(result).toEqual({ ok: true, value: valid });
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
