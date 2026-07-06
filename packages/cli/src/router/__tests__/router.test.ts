import { describe, expect, it, vi } from 'vitest';
import { EXIT_SUCCESS, resolveRoute } from '@pagespace/cli';
import type { ExitCode, Route } from '@pagespace/cli';

function route(path: string[]): Route {
  return { path, handler: vi.fn(async (): Promise<ExitCode> => EXIT_SUCCESS) };
}

describe('resolveRoute', () => {
  it('matches a single-segment route', () => {
    const help = route(['help']);
    const result = resolveRoute([help], ['help']);
    expect(result).toEqual({ kind: 'match', route: help, rest: [] });
  });

  it('matches a multi-segment route and returns trailing args as rest', () => {
    const tokensCreate = route(['tokens', 'create']);
    const result = resolveRoute([tokensCreate], ['tokens', 'create', '--extra']);
    expect(result).toEqual({ kind: 'match', route: tokensCreate, rest: ['--extra'] });
  });

  it('prefers the longest matching path when routes overlap', () => {
    const tokens = route(['tokens']);
    const tokensCreate = route(['tokens', 'create']);
    const result = resolveRoute([tokens, tokensCreate], ['tokens', 'create']);
    expect(result).toEqual({ kind: 'match', route: tokensCreate, rest: [] });
  });

  it('returns a usage error for an unknown command', () => {
    const result = resolveRoute([route(['help'])], ['nope']);
    expect(result).toEqual({ kind: 'usage-error', message: 'Unknown command: nope' });
  });

  it('returns a usage error when no args are given', () => {
    const result = resolveRoute([route(['help'])], []);
    expect(result.kind).toBe('usage-error');
  });
});
