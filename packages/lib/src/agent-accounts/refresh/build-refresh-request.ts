/**
 * `buildRefreshRequest` — the exact request the refresh worker sends to a
 * provider's token endpoint (RFC 6749 §6; client authentication §2.3.1).
 * Pure: the worker passes the pinned endpoint from `decideRefreshEndpoint`,
 * the plane-held client credentials and the refresh token, and hands the
 * result to the pinned HTTPS client.
 *
 * - The destination is a clean https URL: no userinfo, query or fragment.
 * - The refresh token and client secret never appear in the URL: the grant is
 *   the form body; client credentials are either a Basic header (each part
 *   form-urlencoded before base64, §2.3.1) or two more form fields, as the
 *   provider's registry entry says.
 * - A value with a control character, or an empty one, is refused so it can
 *   never split a header or send an empty grant.
 */
import type { OutboundRequest } from '../build-outbound-request';
import type { OAuthProviderEndpoints } from './decide-refresh-endpoint';

/** The plane-held OAuth client for one provider. */
export type OAuthClientCredentials = { readonly clientId: string; readonly clientSecret: string };

export type RefreshRequestVerdict =
  | { readonly ok: true; readonly request: OutboundRequest }
  | { readonly ok: false; readonly reason: 'endpoint_invalid' | 'credential_invalid' };

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;

const usable = (value: string): boolean => value !== '' && !CONTROL_CHAR_RE.test(value);

/** `application/x-www-form-urlencoded` for one value (space as `+`). */
const formEncode = (value: string): string => new URLSearchParams({ v: value }).toString().slice(2);

export function buildRefreshRequest({
  tokenEndpoint,
  clientAuth,
  client,
  refreshToken,
}: {
  readonly tokenEndpoint: string;
  readonly clientAuth: OAuthProviderEndpoints['clientAuth'];
  readonly client: OAuthClientCredentials;
  readonly refreshToken: string;
}): RefreshRequestVerdict {
  let url: URL;
  try {
    url = new URL(tokenEndpoint);
  } catch {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || tokenEndpoint.includes('#')) {
    return { ok: false, reason: 'endpoint_invalid' };
  }
  if (![refreshToken, client.clientId, client.clientSecret].every(usable)) return { ok: false, reason: 'credential_invalid' };

  const port = url.port === '' ? 443 : Number(url.port);
  const authority = port === 443 ? url.hostname : `${url.hostname}:${port}`;
  const form = [`grant_type=refresh_token`, `refresh_token=${formEncode(refreshToken)}`];
  const headers: [string, string][] = [
    ['accept', 'application/json'],
    ['content-type', 'application/x-www-form-urlencoded'],
    ['host', authority],
  ];
  if (clientAuth === 'client_secret_basic') {
    headers.push(['authorization', `Basic ${Buffer.from(`${formEncode(client.clientId)}:${formEncode(client.clientSecret)}`).toString('base64')}`]);
  } else {
    form.push(`client_id=${formEncode(client.clientId)}`, `client_secret=${formEncode(client.clientSecret)}`);
  }
  headers.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    ok: true,
    request: { method: 'POST', url: `https://${authority}${url.pathname}`, hostname: url.hostname, port, headers, body: new TextEncoder().encode(form.join('&')) },
  };
}
