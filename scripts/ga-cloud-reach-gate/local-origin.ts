/**
 * The gate's HTTP target, constrained to LOOPBACK and rebuilt from literals.
 *
 * **Why this exists as its own module, with a taint break rather than a
 * suppression.** `rows.ts` reads the seed file, which carries real session
 * cookies for seeded users, and sends them as request headers. If
 * `GATE_BASE_URL` pointed anywhere but this machine, those cookies would leave
 * the box — a credential exfiltration path opened by a single mistyped
 * environment variable. CodeQL flags exactly this
 * (`js/file-access-to-http`, alert 342), and it is right to.
 *
 * Default-setup CodeQL **ignores inline `codeql[...]` suppressions**, so an
 * annotation would neither clear the alert nor fix the risk. The taint is
 * broken instead: the caller's string is *parsed and checked*, and then
 * **thrown away** — the origin the requests actually use is assembled from
 * string LITERALS chosen by that check, plus a port validated as an integer in
 * range. Nothing attacker-influenced reaches `fetch`.
 *
 * The path is assigned onto an origin-only `URL` rather than concatenated or
 * passed as `new URL(path, origin)`: both of those forms stay flagged even
 * behind a host guard, because the analysis follows the string, not the guard.
 */

/** The only hosts a gate may talk to. Compared as literals, never as a pattern. */
const ALLOWED_HOSTNAMES = ['localhost', '127.0.0.1'] as const;

export class NonLocalGateTargetError extends Error {
  constructor(raw: string, why: string) {
    super(
      `Refusing to run the gate against ${JSON.stringify(raw)}: ${why}. ` +
        'The seed carries real session cookies, so the gate only ever talks to this machine ' +
        `(http://localhost or http://127.0.0.1).`,
    );
    this.name = 'NonLocalGateTargetError';
  }
}

/**
 * Validate a caller-supplied base URL and return a LOOPBACK origin built from
 * literals.
 *
 * @throws NonLocalGateTargetError before any request is made.
 */
export function resolveLocalGateOrigin(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NonLocalGateTargetError(raw, 'it is not a URL');
  }
  // `http:` only. `https:` to a loopback name is still not a shape this gate
  // has any use for, and allowing it widens the check for nothing.
  if (parsed.protocol !== 'http:') {
    throw new NonLocalGateTargetError(raw, `protocol ${parsed.protocol} is not http:`);
  }
  // Credentials in the URL would travel with every request; there is no reason
  // for the gate to carry them and every reason not to.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new NonLocalGateTargetError(raw, 'it embeds credentials');
  }

  // The literal check. `hostname` is already punycode-normalised and free of
  // port, userinfo and brackets, so an exact match against the allowlist is a
  // decision about a host rather than about a string that resembles one.
  const hostname = ALLOWED_HOSTNAMES.find((allowed) => allowed === parsed.hostname);
  if (hostname === undefined) {
    throw new NonLocalGateTargetError(raw, `host ${parsed.hostname} is not this machine`);
  }

  // The port, as an integer in range — never the caller's characters.
  const port = parsed.port === '' ? 80 : Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new NonLocalGateTargetError(raw, `port ${parsed.port} is not a valid port`);
  }

  // Rebuilt from the literal the check chose, plus that integer. `raw` reaches
  // nothing below this line.
  return `http://${hostname}:${port}`;
}

/**
 * A request URL for a gate path, assembled onto an origin-only `URL`.
 *
 * `url.pathname = path` rather than `new URL(path, origin)` or template
 * concatenation: only the assignment form breaks the flow CodeQL follows, and
 * it also cannot be talked into changing the origin by a path that begins
 * `//host`.
 */
export function gateUrl(origin: string, path: string): string {
  const url = new URL(origin);
  const [pathname, search = ''] = path.split('?', 2);
  url.pathname = pathname;
  url.search = search;
  return url.toString();
}
