/**
 * The cloud-reach gate talks to this machine and nowhere else.
 *
 * The gate's seed file carries REAL session cookies for seeded users, and the
 * harness sends them as request headers. A `GATE_BASE_URL` pointing anywhere
 * but loopback would ship those credentials off the box — CodeQL alert 342
 * (`js/file-access-to-http`), and it is a real risk rather than a false
 * positive.
 *
 * These rows pin the two halves of the fix: the REFUSAL happens before any
 * request, and the origin that requests actually use is rebuilt from literals
 * so nothing caller-supplied reaches `fetch`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  gateUrl,
  resolveLocalGateOrigin,
  NonLocalGateTargetError,
} from '../ga-cloud-reach-gate/local-origin';

describe('resolveLocalGateOrigin — loopback only, refused before any request', () => {
  it('refuses a REMOTE target, and refuses it without making a request', () => {
    // The whole point: no network call may happen on the way to the refusal.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const remote of [
      'http://example.com',
      'http://attacker.test:3000',
      'http://localhost.attacker.test',   // a suffix that merely CONTAINS localhost
      'http://127.0.0.1.attacker.test',
      'http://[::1]',                      // not in the allowlist, so not allowed
      'http://169.254.169.254',            // cloud metadata
    ]) {
      expect(() => resolveLocalGateOrigin(remote), remote).toThrow(NonLocalGateTargetError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses a non-http protocol, embedded credentials, and a non-URL', () => {
    expect(() => resolveLocalGateOrigin('https://localhost:3000')).toThrow(/not http:/);
    expect(() => resolveLocalGateOrigin('file:///etc/passwd')).toThrow(NonLocalGateTargetError);
    expect(() => resolveLocalGateOrigin('http://user:pw@localhost:3000')).toThrow(/embeds credentials/);
    expect(() => resolveLocalGateOrigin('not a url at all')).toThrow(/not a URL/);
  });

  it('accepts loopback and returns an origin rebuilt from LITERALS, not from the input', () => {
    expect(resolveLocalGateOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveLocalGateOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    // Everything but the host and port is discarded — path, query, fragment and
    // trailing junk cannot ride along into the origin the requests use.
    expect(resolveLocalGateOrigin('http://localhost:3000/some/path?x=1#frag')).toBe('http://localhost:3000');
    // A bare loopback URL means port 80, stated rather than inherited.
    expect(resolveLocalGateOrigin('http://localhost')).toBe('http://localhost:80');
  });

  it('refuses an out-of-range port rather than coercing it', () => {
    expect(() => resolveLocalGateOrigin('http://localhost:0')).toThrow(NonLocalGateTargetError);
    expect(() => resolveLocalGateOrigin('http://localhost:99999')).toThrow(NonLocalGateTargetError);
  });
});

describe('gateUrl — the path cannot move the request off the origin', () => {
  const origin = resolveLocalGateOrigin('http://localhost:3000');

  it('assembles a path onto the origin', () => {
    expect(gateUrl(origin, '/api/auth/csrf')).toBe('http://localhost:3000/api/auth/csrf');
    expect(gateUrl(origin, '/api/ai/global?limit=1')).toBe('http://localhost:3000/api/ai/global?limit=1');
  });

  it('a protocol-relative path cannot redirect the request to another host', () => {
    // `new URL('//evil.test/x', origin)` would resolve to http://evil.test/x.
    // Assigning `pathname` cannot, which is the reason for the assignment form.
    expect(gateUrl(origin, '//evil.test/x')).toContain('http://localhost:3000/');
    expect(gateUrl(origin, '//evil.test/x')).not.toContain('evil.test/x?');
    expect(new URL(gateUrl(origin, '//evil.test/x')).hostname).toBe('localhost');
    expect(new URL(gateUrl(origin, 'https://evil.test/x')).hostname).toBe('localhost');
  });
});
