import { describe, it, expect } from 'vitest';
import { resolveStepArgs, MAX_RESOLVED_STRING_LENGTH } from './resolve-step-args';

describe('resolveStepArgs', () => {
  const payload = {
    issue: { title: 'Login broken', number: 42, urgent: true },
    author: { login: 'octocat' },
    'dash-key': { under_score: 'ok' },
  };

  it('passes through args with no references unchanged', () => {
    const args = { title: 'Doc', content: 'static text', position: 'after' };
    const result = resolveStepArgs(args, payload);
    expect(result).toEqual({ ok: true, args });
  });

  it('resolves a top-level string reference', () => {
    const result = resolveStepArgs({ content: { $payload: 'author.login' } }, payload);
    expect(result).toEqual({ ok: true, args: { content: 'octocat' } });
  });

  it('resolves number and boolean references', () => {
    const result = resolveStepArgs(
      { n: { $payload: 'issue.number' }, b: { $payload: 'issue.urgent' } },
      payload
    );
    expect(result).toEqual({ ok: true, args: { n: 42, b: true } });
  });

  it('resolves references nested inside objects and arrays', () => {
    const result = resolveStepArgs(
      { outer: { inner: { $payload: 'issue.title' } }, list: ['x', { $payload: 'author.login' }] },
      payload
    );
    expect(result).toEqual({
      ok: true,
      args: { outer: { inner: 'Login broken' }, list: ['x', 'octocat'] },
    });
  });

  it('allows dash and underscore segments', () => {
    const result = resolveStepArgs({ v: { $payload: 'dash-key.under_score' } }, payload);
    expect(result).toEqual({ ok: true, args: { v: 'ok' } });
  });

  it('strict-fails when the path is missing from the payload', () => {
    const result = resolveStepArgs({ v: { $payload: 'issue.missing' } }, payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('issue.missing');
  });

  it('strict-fails on any reference when no payload exists (cron/manual runs)', () => {
    const result = resolveStepArgs({ v: { $payload: 'issue.title' } }, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no trigger payload/i);
  });

  it('fails when the resolved value is an object or array', () => {
    const result = resolveStepArgs({ v: { $payload: 'issue' } }, payload);
    expect(result.ok).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects %s path segments', (seg) => {
    const result = resolveStepArgs({ v: { $payload: `a.${seg}.b` } }, { a: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects invalid path syntax', () => {
    for (const bad of ['', '.', 'a..b', 'a.b!', 'a b', 'a/../b']) {
      const result = resolveStepArgs({ v: { $payload: bad } }, payload);
      expect(result.ok, `path "${bad}" should be rejected`).toBe(false);
    }
  });

  it('rejects paths deeper than 8 segments', () => {
    const result = resolveStepArgs({ v: { $payload: 'a.b.c.d.e.f.g.h.i' } }, payload);
    expect(result.ok).toBe(false);
  });

  it('rejects a $payload object carrying extra keys (malformed reference)', () => {
    const result = resolveStepArgs(
      { v: { $payload: 'issue.title', extra: 1 } as unknown as Record<string, unknown> },
      payload
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a $payload value that is not a string', () => {
    const result = resolveStepArgs({ v: { $payload: 42 } as unknown }, payload);
    expect(result.ok).toBe(false);
  });

  it('caps resolved strings at MAX_RESOLVED_STRING_LENGTH', () => {
    const long = 'x'.repeat(MAX_RESOLVED_STRING_LENGTH + 1);
    const result = resolveStepArgs({ v: { $payload: 'big' } }, { big: long });
    expect(result.ok).toBe(false);

    const exact = 'x'.repeat(MAX_RESOLVED_STRING_LENGTH);
    const ok = resolveStepArgs({ v: { $payload: 'big' } }, { big: exact });
    expect(ok.ok).toBe(true);
  });

  it('does not resolve through prototype chains (own properties only)', () => {
    const result = resolveStepArgs({ v: { $payload: 'a.toString' } }, { a: {} });
    expect(result.ok).toBe(false);
  });

  it('resolves numeric segments as array indices', () => {
    const result = resolveStepArgs({ v: { $payload: 'items.0.name' } }, { items: [{ name: 'first' }] });
    expect(result).toEqual({ ok: true, args: { v: 'first' } });
  });

  it('fails on args nested beyond the depth cap', () => {
    let deep: Record<string, unknown> = { v: 'leaf' };
    for (let i = 0; i < 20; i++) deep = { nest: deep };
    const result = resolveStepArgs(deep, payload);
    expect(result.ok).toBe(false);
  });

  it('does not mutate the input args', () => {
    const args = { a: { $payload: 'author.login' }, b: { c: 'static' } };
    const snapshot = JSON.parse(JSON.stringify(args));
    resolveStepArgs(args, payload);
    expect(args).toEqual(snapshot);
  });
});
