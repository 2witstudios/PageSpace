/**
 * Transport security for the bridge (CWE-319): the challenge/response, the
 * minted `env:bridge` token, and the socket all carry proof-of-possession or
 * a bearer token, so they must never travel in cleartext to a remote host.
 *
 * The rule mirrors the CLI's existing OAuth posture, in ONE place: HTTPS is
 * required, with a plaintext exception ONLY for the loopback hosts the
 * OAuth loopback flow already trusts for local development (`127.0.0.1`,
 * `::1`, `localhost`; RFC 8252 §7.3, see `auth/create-loopback-server.ts`).
 * A plaintext `--host pagespace.ai` or an RFC1918 address is refused, fail
 * closed, before anything leaves the machine.
 */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname === '[::1]';
}

/** @returns the host unchanged when it is https, or http to a loopback host; throws otherwise. */
export function assertSecureHost(host: string): string {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`Invalid host "${host}": expected an https:// URL.`);
  }
  if (url.protocol === 'https:') return host;
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return host;
  throw new Error(`Refusing to use ${host}: the bridge sends this machine's proof and a bearer token, so the host must be https:// (http:// is allowed only for localhost during development).`);
}

/** The `wss://…/api/env-bridge/ws?envId=…` URL, derived from a validated host (`ws://` only for a loopback http host). */
export function bridgeSocketUrl(host: string, envId: string): string {
  const secure = assertSecureHost(host);
  const url = new URL(secure);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/env-bridge/ws';
  url.search = `?envId=${encodeURIComponent(envId)}`;
  return url.toString();
}
