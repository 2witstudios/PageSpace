import { describe, it, expect } from 'vitest';
import { proxyTargets, targetFor } from '../e2e-proxy-routes';

/**
 * The e2e proxy is the production edge in miniature: one origin, split by path. A wrong rule
 * does not fail loudly — imago's sign-in round trip would land on web's 404, or the socket
 * would silently miss realtime — so the split itself is pinned here.
 */

const WEB = new URL('http://127.0.0.1:3100');
const REALTIME = new URL('http://127.0.0.1:3001');
const IMAGO = new URL('http://127.0.0.1:3106');

const withImago = { web: WEB, realtime: REALTIME, imago: IMAGO };
const withoutImago = { web: WEB, realtime: REALTIME, imago: null };

describe('targetFor', () => {
  it('sends the bare imago root to imago', () => {
    expect(targetFor('/imago', withImago)).toBe(IMAGO);
  });

  it('sends imago pages, assets and API under the basePath to imago', () => {
    expect(targetFor('/imago/drive-1/files', withImago)).toBe(IMAGO);
    expect(targetFor('/imago/_next/static/chunks/main.js', withImago)).toBe(IMAGO);
    expect(targetFor('/imago/api/health', withImago)).toBe(IMAGO);
    expect(targetFor('/imago?x=1', withImago)).toBe(IMAGO);
  });

  it('leaves a path that only starts with the letters of imago on web', () => {
    expect(targetFor('/imagonary', withImago)).toBe(WEB);
    expect(targetFor('/dashboard/imago', withImago)).toBe(WEB);
  });

  it('keeps sign-in and the API on web, as the production edge does', () => {
    expect(targetFor('/auth/signin?next=%2Fimago', withImago)).toBe(WEB);
    expect(targetFor('/api/auth/magic-link/verify?token=t', withImago)).toBe(WEB);
    expect(targetFor('/', withImago)).toBe(WEB);
    expect(targetFor(undefined, withImago)).toBe(WEB);
  });

  it('sends socket.io to realtime', () => {
    expect(targetFor('/socket.io/?EIO=4&transport=polling', withImago)).toBe(REALTIME);
  });

  it('sends imago paths to web when no imago target is configured', () => {
    expect(targetFor('/imago/drive-1', withoutImago)).toBe(WEB);
  });
});

describe('proxyTargets', () => {
  it('reads the three targets from the environment', () => {
    expect(
      proxyTargets({
        E2E_WEB_TARGET: 'http://127.0.0.1:3100',
        E2E_REALTIME_TARGET: 'http://127.0.0.1:3001',
        E2E_IMAGO_TARGET: 'http://127.0.0.1:3106',
      }),
    ).toEqual(withImago);
  });

  it('defaults web and realtime and leaves imago off when unset', () => {
    expect(proxyTargets({})).toEqual(withoutImago);
  });
});
