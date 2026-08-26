import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { pushNotificationTokens } from '@pagespace/db/schema/push-notifications';
import { createId } from '@paralleldrive/cuid2';
import * as crypto from 'crypto';
import * as http2 from 'node:http2';

type PushPlatform = 'ios' | 'android' | 'web';

export interface PushNotificationPayload {
  title?: string;
  body?: string;
  badge?: number;
  sound?: string;
  data?: Record<string, unknown>;
  category?: string;
  threadId?: string;
  silent?: boolean;
}

interface SendPushResult {
  success: boolean;
  tokenId: string;
  error?: string;
  shouldRemoveToken?: boolean;
  // The send failed before the push service ever rendered a verdict on this
  // token — a missing credential, a refused OAuth mint, a dead socket. The
  // dispatch loop must not count that against the device.
  serverFault?: boolean;
}

// Both the APNs JWT (ES256) and the FCM OAuth2 assertion (RS256) are JWTs, so
// they share one base64url encoder.
function base64UrlEncode(input: object | string | Buffer): string {
  const buffer =
    Buffer.isBuffer(input)
      ? input
      : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input));
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// APNs JWT token cache
let apnsJwtToken: string | null = null;
let apnsJwtExpiry: number = 0;

function getApnsJwtToken(): string {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if still valid (tokens are valid for 1 hour, refresh at 50 min)
  if (apnsJwtToken && apnsJwtExpiry > now + 600) {
    return apnsJwtToken;
  }

  const teamId = process.env.APNS_TEAM_ID;
  const keyId = process.env.APNS_KEY_ID;
  const privateKey = process.env.APNS_PRIVATE_KEY;

  if (!teamId || !keyId || !privateKey) {
    throw new Error('APNs configuration missing: APNS_TEAM_ID, APNS_KEY_ID, and APNS_PRIVATE_KEY are required');
  }

  // Create JWT header and claims
  const header = {
    alg: 'ES256',
    kid: keyId,
  };

  const claims = {
    iss: teamId,
    iat: now,
  };

  const headerB64 = base64UrlEncode(header);
  const claimsB64 = base64UrlEncode(claims);
  const signingInput = `${headerB64}.${claimsB64}`;

  // Sign with ES256 (ECDSA P-256)
  const sign = crypto.createSign('SHA256');
  sign.update(signingInput);
  sign.end();

  // The private key should be in PEM format
  const formattedKey = privateKey.includes('-----BEGIN')
    ? privateKey
    : `-----BEGIN PRIVATE KEY-----\n${privateKey}\n-----END PRIVATE KEY-----`;

  const signature = sign.sign(formattedKey);

  // Convert DER signature to raw r||s format for JWT
  // DER format: 0x30 [len] 0x02 [r_len] [r] 0x02 [s_len] [s]
  const derToRaw = (der: Buffer): Buffer => {
    let offset = 2; // Skip sequence tag and length
    const rLen = der[offset + 1];
    const r = der.slice(offset + 2, offset + 2 + rLen);
    offset = offset + 2 + rLen;
    const sLen = der[offset + 1];
    const s = der.slice(offset + 2, offset + 2 + sLen);

    // Ensure r and s are 32 bytes each (pad or trim leading zeros)
    const rPadded = Buffer.alloc(32);
    const sPadded = Buffer.alloc(32);

    if (r.length <= 32) {
      r.copy(rPadded, 32 - r.length);
    } else {
      r.copy(rPadded, 0, r.length - 32);
    }

    if (s.length <= 32) {
      s.copy(sPadded, 32 - s.length);
    } else {
      s.copy(sPadded, 0, s.length - 32);
    }

    return Buffer.concat([rPadded, sPadded]);
  };

  const signatureB64 = base64UrlEncode(derToRaw(signature));

  apnsJwtToken = `${signingInput}.${signatureB64}`;
  apnsJwtExpiry = now + 3600; // Token is valid for 1 hour

  return apnsJwtToken;
}

// APNs is HTTP/2-only. Node's global fetch (undici) speaks HTTP/1.1 and does not
// upgrade, so a POST to api.push.apple.com fails with an opaque "fetch failed".
// We use node:http2 with a long-lived, multiplexed session per host — APNs
// strongly prefers reusing a single connection across many sends. A failed
// session is evicted and closed so the next send transparently reconnects.
const apnsSessions = new Map<string, http2.ClientHttp2Session>();

function getApnsSession(host: string): http2.ClientHttp2Session {
  const existing = apnsSessions.get(host);
  if (existing && !existing.closed && !existing.destroyed) return existing;

  const session = http2.connect(`https://${host}`);
  // Only drop this session from the cache if it's still the cached one — a newer
  // session may have replaced it, and we must not evict that healthy replacement.
  const evictIfCurrent = () => {
    if (apnsSessions.get(host) === session) apnsSessions.delete(host);
  };
  session.on('error', evictIfCurrent);
  session.on('close', evictIfCurrent);
  session.on('goaway', () => {
    try { session.close(); } catch { /* noop */ }
    evictIfCurrent();
  });
  // Don't let the pooled connection keep the process alive / block shutdown.
  session.socket?.unref?.();

  apnsSessions.set(host, session);
  return session;
}

// Evict a session after a transport failure AND gracefully close it. req.close()
// only cancels the stream; without this the underlying HTTP/2 socket stays open,
// so repeated APNs stalls/outages would leak connections/FDs as each retry opens
// a fresh session. close() lets any other in-flight streams drain, then releases
// the socket; the next send transparently reconnects.
function evictApnsSession(host: string, session: http2.ClientHttp2Session): void {
  if (apnsSessions.get(host) === session) apnsSessions.delete(host);
  try { session.close(); } catch { /* noop */ }
}

interface ApnsTransportResult {
  status: number;
  apnsId: string | null;
  body: string;
}

function performApnsRequest(
  session: http2.ClientHttp2Session,
  requestHeaders: http2.OutgoingHttpHeaders,
  body: string
): Promise<ApnsTransportResult> {
  return new Promise<ApnsTransportResult>((resolve, reject) => {
    const req = session.request(requestHeaders);

    let status = 0;
    let apnsId: string | null = null;
    let responseBody = '';
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('response', (headers) => {
      status = headers[':status'] ?? 0;
      const rawApnsId = headers['apns-id'];
      apnsId = Array.isArray(rawApnsId) ? (rawApnsId[0] ?? null) : (rawApnsId ?? null);
    });

    req.on('data', (chunk: Buffer | string) => {
      responseBody += chunk.toString();
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ status, apnsId, body: responseBody });
    });

    req.on('error', (error) => {
      fail(error);
    });

    // A hung stream must not wedge the caller — cancel and surface as an error.
    req.setTimeout(10000, () => {
      req.close(http2.constants.NGHTTP2_CANCEL);
      fail(new Error('APNs request timed out after 10000ms'));
    });

    req.write(body);
    req.end();
  });
}

async function sendToApns(
  deviceToken: string,
  payload: PushNotificationPayload,
  tokenId: string
): Promise<SendPushResult> {
  const bundleId = process.env.APNS_BUNDLE_ID || 'ai.pagespace.ios';
  const isProduction = process.env.NODE_ENV === 'production';
  const apnsHost = isProduction
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';

  // Only set once a session is actually opened, so a JWT-signing failure (which
  // happens before any connection) never evicts/closes a healthy cached session.
  let usedSession: http2.ClientHttp2Session | null = null;

  try {
    const jwtToken = getApnsJwtToken();

    const isSilent = payload.silent === true;
    const apnsPayload: Record<string, unknown> = isSilent
      ? {
          aps: {
            'content-available': 1,
            ...(payload.badge !== undefined && { badge: payload.badge }),
          },
          ...payload.data,
        }
      : {
          aps: {
            alert: {
              title: payload.title ?? '',
              body: payload.body ?? '',
            },
            badge: payload.badge,
            sound: payload.sound || 'default',
            'thread-id': payload.threadId,
            category: payload.category,
          },
          ...payload.data,
        };

    console.log('[APNs] send', {
      host: apnsHost,
      bundleId,
      tokenId,
      tokenPrefix: deviceToken.slice(0, 8),
      isSilent,
    });

    const session = getApnsSession(apnsHost);
    usedSession = session;
    const requestHeaders: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwtToken}`,
      'apns-topic': bundleId,
      'apns-push-type': isSilent ? 'background' : 'alert',
      'apns-priority': isSilent ? '5' : '10',
      'content-type': 'application/json',
    };

    const { status, apnsId, body } = await performApnsRequest(
      session,
      requestHeaders,
      JSON.stringify(apnsPayload)
    );

    if (status === 200) {
      console.log('[APNs] accepted', { tokenId, apnsId });
      return { success: true, tokenId };
    }

    let reason = 'Unknown error';
    if (body) {
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason || 'Unknown error';
      } catch {
        // Non-JSON body — keep the default reason.
      }
    }

    console.error('[APNs] reject', {
      status,
      reason,
      apnsId,
      host: apnsHost,
      bundleId,
      tokenId,
    });

    // Check if token should be removed (invalid or unregistered)
    const invalidTokenReasons = [
      'BadDeviceToken',
      'Unregistered',
      'DeviceTokenNotForTopic',
      'ExpiredToken',
    ];

    return {
      success: false,
      tokenId,
      error: reason,
      shouldRemoveToken: invalidTokenReasons.includes(reason),
    };
  } catch (error) {
    // A transport failure (stream error/timeout) may have poisoned the session,
    // and req.close() only cancels the stream — evict AND close the specific
    // session used so its socket is released and the next send reconnects.
    if (usedSession) evictApnsSession(apnsHost, usedSession);

    // The original `fetch failed` bug was opaque because only error.message was
    // logged — surface the stack and any transport error code for legibility.
    const code = (error as { code?: string }).code;
    console.error('[APNs] send error', {
      tokenId,
      host: apnsHost,
      bundleId,
      error: error instanceof Error ? (error.stack ?? error.message) : error,
      ...(code ? { code } : {}),
    });
    return {
      success: false,
      tokenId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}


// ---------------------------------------------------------------------------
// FCM (Firebase Cloud Messaging) HTTP v1
//
// The v1 API is OAuth2-only: every send needs a Bearer access token minted from
// the service-account credentials via a JWT-bearer grant. That mint is a real
// network round-trip, so — exactly like the APNs JWT above — the token is cached
// at module level and refreshed ahead of expiry rather than per send.
//
// Config lives in one env var, `FCM_SERVICE_ACCOUNT_JSON` (the raw service
// account JSON Firebase hands you). The project id is derived from it, so there
// is no second variable to keep in sync. When the secret is absent the send
// fails with a configuration error — the dispatch loop keeps going and other
// platforms still deliver.
// ---------------------------------------------------------------------------

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

// Everything below parses untrusted JSON — a secret typed by a human, and error
// bodies from Google — so narrow rather than cast.
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseFcmServiceAccount(raw: string): FcmServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FCM configuration invalid: FCM_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  const account = asRecord(parsed);
  if (!account) {
    throw new Error('FCM configuration invalid: FCM_SERVICE_ACCOUNT_JSON must be a JSON object');
  }

  const str = (key: string): string =>
    typeof account[key] === 'string' ? (account[key] as string) : '';

  const projectId = str('project_id');
  const clientEmail = str('client_email');
  const privateKey = str('private_key');

  const missing = [
    ...(projectId ? [] : ['project_id']),
    ...(clientEmail ? [] : ['client_email']),
    ...(privateKey ? [] : ['private_key']),
  ];
  if (missing.length > 0) {
    throw new Error(
      `FCM configuration invalid: FCM_SERVICE_ACCOUNT_JSON is missing ${missing.join(', ')}`
    );
  }

  // The project id is interpolated into the messages:send path, so a stray `/`
  // or `..` from a mistyped secret would silently aim the send at a different
  // endpoint. Firebase ids are lowercase alphanumerics and hyphens; the check is
  // kept a shade wider than that so a legitimate id is never rejected, while
  // everything that could change the meaning of the URL still is.
  //
  // It has to start with an alphanumeric, not merely consist of the permitted
  // characters. `.` and `..` are made only of permitted characters and are also
  // exactly the two dot segments URL parsing collapses: as project ids they turn
  // the endpoint into `/v1/projects/messages:send` and `/v1/messages:send`
  // respectively, so the send would be posted somewhere else entirely instead of
  // failing here as promised. An interior dot is harmless — only a whole segment
  // of dots is special — so `a..b` stays allowed.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(projectId)) {
    throw new Error(
      'FCM configuration invalid: FCM_SERVICE_ACCOUNT_JSON project_id must start with a letter or digit, and may otherwise contain only letters, digits, dots, underscores and hyphens'
    );
  }

  // token_uri is fetched with the signed assertion in the body. It comes out of
  // the credential itself so it is not an attacker-controlled boundary, but a
  // mistyped http:// would put that assertion on the wire in cleartext.
  const tokenUri = str('token_uri') || FCM_DEFAULT_TOKEN_URI;
  if (!tokenUri.startsWith('https://')) {
    throw new Error(
      'FCM configuration invalid: FCM_SERVICE_ACCOUNT_JSON token_uri must be an https:// URL'
    );
  }

  return {
    projectId,
    clientEmail,
    // Secret stores (Fly, .env) commonly deliver the PEM with literal backslash-n
    // rather than real newlines; crypto rejects that outright.
    privateKey: privateKey.includes('\\n') ? privateKey.replace(/\\n/g, '\n') : privateKey,
    tokenUri,
  };
}

// FCM OAuth2 access token cache. `fcmAccessTokenSource` pins the cache to the
// exact credential string it was minted from, so a rotated secret is never
// served a stale token from the previous service account.
let fcmAccessToken: string | null = null;
let fcmAccessTokenExpiry: number = 0;
let fcmAccessTokenSource: string | null = null;

// A mint that is already in the air. Sends fan out concurrently — broadcastTos-
// PrivacyUpdate creates a notification for every user through Promise.all — and
// on a cold cache each one would otherwise observe "no token" and open its own
// OAuth request, one per Android recipient. Waiters share a single mint instead.
let fcmMintInFlight: Promise<string> | null = null;
let fcmMintInFlightSource: string | null = null;

// The three cache fields are one value and must move together: a token, when it
// dies, and which credential produced it. They are written by a successful mint
// and cleared by a rejected one, from two different functions, so the two
// transitions are named rather than open-coded at each site.
function cacheFcmAccessToken(token: string, expiresAt: number, source: string): void {
  fcmAccessToken = token;
  fcmAccessTokenExpiry = expiresAt;
  fcmAccessTokenSource = source;
}

function clearFcmAccessToken(): void {
  fcmAccessToken = null;
  fcmAccessTokenExpiry = 0;
  fcmAccessTokenSource = null;
}

// Evict only if the cache still holds the token that was actually rejected —
// the same "is it still ours" guard the APNs session pool and the in-flight
// mint slot already use. Under fan-out many requests are in the air carrying
// one token, so the first 401 handled mints a replacement while later 401s
// from requests made with the OLD token are still arriving. An unconditional
// clear would throw that replacement away and start another mint per late
// response, which is precisely the per-recipient mint burst the single-flight
// exists to prevent.
function clearFcmAccessTokenIfCurrent(rejected: string): void {
  if (fcmAccessToken === rejected) clearFcmAccessToken();
}

async function getFcmAccessToken(): Promise<{ accessToken: string; projectId: string }> {
  const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('FCM configuration missing: FCM_SERVICE_ACCOUNT_JSON is required');
  }

  const account = parseFcmServiceAccount(raw);

  // Google access tokens live for 1 hour; refresh at 50 min, as APNs does.
  if (
    fcmAccessToken &&
    fcmAccessTokenSource === raw &&
    fcmAccessTokenExpiry > Math.floor(Date.now() / 1000) + 600
  ) {
    return { accessToken: fcmAccessToken, projectId: account.projectId };
  }

  // Join the in-flight mint only when it is for this same credential — a waiter
  // for a rotated secret must never be handed the previous account's token.
  if (!fcmMintInFlight || fcmMintInFlightSource !== raw) {
    const guarded: Promise<string> = mintFcmAccessToken(account, raw).finally(() => {
      // Only clear the slot if it is still ours; a newer mint may have replaced it.
      if (fcmMintInFlight === guarded) {
        fcmMintInFlight = null;
        fcmMintInFlightSource = null;
      }
    });
    fcmMintInFlight = guarded;
    fcmMintInFlightSource = raw;
  }

  return { accessToken: await fcmMintInFlight, projectId: account.projectId };
}

async function mintFcmAccessToken(account: FcmServiceAccount, raw: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: account.tokenUri,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64UrlEncode(header)}.${base64UrlEncode(claims)}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  sign.end();
  // RS256 signatures are already the raw value JWT wants — no DER unwrapping,
  // unlike the ES256 path APNs uses.
  const assertion = `${signingInput}.${base64UrlEncode(sign.sign(account.privateKey))}`;

  // No cache invalidation is needed on any failure below: the cache is only ever
  // written by a fully successful mint, and we only get here when it was already
  // stale or minted from a different credential. sendToFcm's 401 handler is the
  // one place a *populated* cache has to be dropped.
  const response = await fetch(account.tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `FCM OAuth token request failed (${response.status}): ${text.slice(0, 200)}`
    );
  }

  let grant: { access_token?: unknown; expires_in?: unknown };
  try {
    grant = JSON.parse(text) as { access_token?: unknown; expires_in?: unknown };
  } catch {
    throw new Error('FCM OAuth token response was not valid JSON');
  }

  if (typeof grant.access_token !== 'string' || grant.access_token.length === 0) {
    throw new Error('FCM OAuth token response did not include an access_token');
  }

  const expiresIn = typeof grant.expires_in === 'number' ? grant.expires_in : 3600;

  cacheFcmAccessToken(grant.access_token, now + expiresIn, raw);

  return grant.access_token;
}

// FCM data payloads are string→string only; anything else is rejected by the API.
function toFcmDataRecord(data: Record<string, unknown> | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    record[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return record;
}

// Matched by suffix so a version bump in the type URL does not stop matching.
// In practice `type.googleapis.com/google.firebase.fcm.v1.FcmError` and
// `type.googleapis.com/google.rpc.BadRequest`.
const FCM_ERROR_DETAIL_TYPE_SUFFIX = '.FcmError';
const BAD_REQUEST_DETAIL_TYPE_SUFFIX = '.BadRequest';
// The field a BadRequest names when it is the registration token it rejected.
const FCM_TOKEN_FIELD = 'message.token';
// The one FcmError code that unambiguously means this token is dead.
const FCM_UNREGISTERED = 'UNREGISTERED';

interface FcmError {
  code: string;
  message: string;
  // True only when FCM's answer was about *this registration token*, as opposed
  // to about the request, the message, the project or the deployment. Only this
  // may cost a device its registration.
  tokenIsDead: boolean;
}

// FCM answers two different questions in one error body, and telling them apart
// is the whole job here. Exactly two things mean this specific token is dead:
//
//   - an FcmError detail of UNREGISTERED — the app was uninstalled or the token
//     was replaced. This is the one code firebase-admin's own cleanup guidance
//     acts on, and it is unambiguous.
//   - a BadRequest fieldViolation naming `message.token` — FCM parsed the
//     request and rejected that field specifically, i.e. the token is malformed.
//     This, not a bare INVALID_ARGUMENT, is how a garbage token actually
//     reports; gating on the FcmError detail alone would never deactivate one.
//
// Everything else is about us, not the device, and is deliberately excluded:
//
//   - SENDER_ID_MISMATCH arrives *inside* an FcmError detail, so it looks
//     token-scoped, but it is a project-level fact. Point the server at another
//     Firebase project's service account — a staging credential pasted into
//     prod — and every send 403s with it. Acting on it would set isActive:false
//     on every Android registration in the database on the first dispatch after
//     that deploy, and correcting the secret would not bring them back: each
//     device stays dark until the app relaunches and re-registers.
//   - a bare INVALID_ARGUMENT is what a malformed *message* returns, and
//     `createNotification` spreads arbitrary `metadata` into `data` against a
//     4 KB cap, so one oversized notification could otherwise unregister every
//     recipient of that notification type.
//   - NOT_FOUND without a detail is a wrong project id, same argument.
function extractFcmError(body: string): FcmError {
  const unknown: FcmError = { code: 'UNKNOWN', message: 'Unknown error', tokenIsDead: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return unknown;
  }

  // An absent or non-object `error` needs no early return: every read below
  // already falls back, and an empty object produces exactly `unknown`.
  const error = asRecord(asRecord(parsed)?.error) ?? {};

  const message = typeof error.message === 'string' ? error.message : 'Unknown error';

  let fcmErrorCode: string | null = null;
  let tokenFieldRejected = false;

  for (const entry of Array.isArray(error.details) ? error.details : []) {
    const detail = asRecord(entry);
    if (!detail) continue;
    const type = typeof detail['@type'] === 'string' ? detail['@type'] : '';

    if (type.endsWith(FCM_ERROR_DETAIL_TYPE_SUFFIX) && typeof detail.errorCode === 'string') {
      fcmErrorCode ??= detail.errorCode;
    }

    if (type.endsWith(BAD_REQUEST_DETAIL_TYPE_SUFFIX)) {
      const violations = Array.isArray(detail.fieldViolations) ? detail.fieldViolations : [];
      if (violations.some((v) => asRecord(v)?.field === FCM_TOKEN_FIELD)) {
        tokenFieldRejected = true;
      }
    }
  }

  const status = typeof error.status === 'string' ? error.status : 'UNKNOWN';
  return {
    code: fcmErrorCode ?? status,
    message,
    tokenIsDead: fcmErrorCode === FCM_UNREGISTERED || tokenFieldRejected,
  };
}


// The `message` of an FCM HTTP v1 send. Pure, so the two shapes it can produce —
// a visible alert and a data-only background push — are testable without a
// transport, and so sendToFcm below is only auth, transport and classification.
function buildFcmMessage(
  deviceToken: string,
  payload: PushNotificationPayload
): Record<string, unknown> {
  const isSilent = payload.silent === true;

  // Caller data first, then the first-class payload fields — createNotification
  // spreads arbitrary `metadata` into `data`, and a key that happens to be
  // named `badge` or `silent` must not be able to redefine what we send.
  const data = toFcmDataRecord(payload.data);
  if (payload.badge !== undefined) data.badge = String(payload.badge);
  if (payload.threadId) data.threadId = payload.threadId;
  if (payload.category) data.category = payload.category;

  // A silent push must be data-only: including a `notification` block makes
  // Android render a tray notification itself, no matter what the app does.
  // Title/body ride along as data so the client can decide for itself.
  if (isSilent) {
    data.silent = 'true';
    if (payload.title !== undefined) data.title = payload.title;
    if (payload.body !== undefined) data.body = payload.body;

    return {
      token: deviceToken,
      data,
      // Match APNs, which sends background pushes at priority 5 rather than 10.
      android: { priority: 'normal' },
    };
  }

  return {
    token: deviceToken,
    data,
    notification: {
      title: payload.title ?? '',
      body: payload.body ?? '',
    },
    android: {
      priority: 'high',
      notification: {
        // `sound` names a res/raw resource on Android, not an iOS bundle
        // filename, so forwarding a custom iOS sound would resolve to nothing
        // and silently mute the notification. Only the literal 'default'
        // crosses over; anything else is left to the notification channel,
        // which at worst plays its own sound rather than none.
        ...(payload.sound === undefined || payload.sound === 'default'
          ? { sound: 'default' }
          : {}),
        ...(payload.badge !== undefined && { notification_count: payload.badge }),
        ...(payload.threadId ? { tag: payload.threadId } : {}),
        // Deliberately no `click_action`. payload.category is an iOS category
        // identifier; on Android click_action must match an activity
        // intent-filter, and the manifest declares only MAIN/LAUNCHER — so
        // setting it would make tapping the notification do nothing at all
        // rather than open the app. The category still rides in `data`.
      },
    },
  };
}

function postFcmMessage(
  projectId: string,
  accessToken: string,
  message: Record<string, unknown>
): Promise<Response> {
  return fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(10000),
  });
}

async function sendToFcm(
  deviceToken: string,
  payload: PushNotificationPayload,
  tokenId: string
): Promise<SendPushResult> {
  const isSilent = payload.silent === true;

  try {
    const { accessToken, projectId } = await getFcmAccessToken();
    const message = buildFcmMessage(deviceToken, payload);

    console.log('[FCM] send', {
      projectId,
      tokenId,
      tokenPrefix: deviceToken.slice(0, 8),
      isSilent,
    });

    let response = await postFcmMessage(projectId, accessToken, message);
    let body = await response.text();

    // A 401 means the cached access token was revoked or rotated out from under
    // us. Drop it and retry once with a fresh mint: the token is cached for up
    // to 50 minutes and fan-out sends run concurrently, so without the retry
    // every send holding the stale credential in that window is lost, not just
    // the one that discovered it. The retry is not itself retried.
    if (response.status === 401) {
      clearFcmAccessTokenIfCurrent(accessToken);
      console.warn('[FCM] access token rejected, re-minting and retrying once', { tokenId });

      const refreshed = await getFcmAccessToken();
      response = await postFcmMessage(refreshed.projectId, refreshed.accessToken, message);
      body = await response.text();
    }

    if (response.ok) {
      console.log('[FCM] accepted', { tokenId });
      return { success: true, tokenId };
    }

    const { code, message: reason, tokenIsDead } = extractFcmError(body);

    // The device is accountable only when FCM rendered a verdict about the
    // token itself. Every other rejection is about us: a revoked or rotated
    // credential (401), a wrong-project credential (403 SENDER_ID_MISMATCH), a
    // message we built badly (400), a quota we blew (429), an FCM outage (5xx).
    // None of those say anything about the phone, and five in a row would
    // otherwise write isActive:false across every Android registration in the
    // database — the exact fleet-wide outage the token-scoped verdict above
    // exists to prevent, arrived at five notifications later instead of one.
    //
    // Deliberately not a list of statuses. Any list is a list of the failures
    // someone thought of, and the cost of missing one is the whole install
    // base; 404-wrong-project, 429 and 400-malformed-message would all have
    // been missed by the obvious enumeration. Nothing is lost by declining to
    // infer death from repeated failure, because FCM reports a genuinely dead
    // token authoritatively and immediately.
    const serverFault = !tokenIsDead;

    console.error('[FCM] reject', {
      status: response.status,
      code,
      tokenIsDead,
      serverFault,
      reason,
      projectId,
      tokenId,
    });

    return {
      success: false,
      tokenId,
      error: `${code}: ${reason}`,
      shouldRemoveToken: tokenIsDead,
      serverFault,
    };
  } catch (error) {
    console.error('[FCM] send error', {
      tokenId,
      isSilent,
      error: error instanceof Error ? (error.stack ?? error.message) : error,
    });
    // Nothing here is the device's fault: a missing or malformed credential, a
    // refused OAuth mint, a dead socket. FCM never rendered a verdict on this
    // token, so the loop must not put a strike against it.
    return {
      success: false,
      tokenId,
      error: error instanceof Error ? error.message : 'Unknown error',
      serverFault: true,
    };
  }
}

export async function registerPushToken(
  userId: string,
  token: string,
  platform: PushPlatform,
  deviceId?: string,
  deviceName?: string,
  webPushSubscription?: string
): Promise<{ id: string }> {
  // Check if this token already exists for this user
  const existing = await db.query.pushNotificationTokens.findFirst({
    where: and(
      eq(pushNotificationTokens.userId, userId),
      eq(pushNotificationTokens.token, token)
    ),
  });

  if (existing) {
    // Update the existing token
    await db
      .update(pushNotificationTokens)
      .set({
        isActive: true,
        deviceId,
        deviceName,
        webPushSubscription,
        updatedAt: new Date(),
        failedAttempts: '0',
        lastFailedAt: null,
      })
      .where(eq(pushNotificationTokens.id, existing.id));

    return { id: existing.id };
  }

  // If deviceId is provided, deactivate other tokens for the same device
  if (deviceId) {
    await db
      .update(pushNotificationTokens)
      .set({ isActive: false })
      .where(
        and(
          eq(pushNotificationTokens.userId, userId),
          eq(pushNotificationTokens.deviceId, deviceId),
          eq(pushNotificationTokens.platform, platform)
        )
      );
  }

  // Create new token
  const id = createId();
  await db.insert(pushNotificationTokens).values({
    id,
    userId,
    token,
    platform,
    deviceId,
    deviceName,
    webPushSubscription,
    isActive: true,
  });

  return { id };
}

export async function unregisterPushToken(
  userId: string,
  token: string
): Promise<void> {
  await db
    .update(pushNotificationTokens)
    .set({ isActive: false })
    .where(
      and(
        eq(pushNotificationTokens.userId, userId),
        eq(pushNotificationTokens.token, token)
      )
    );
}

export async function unregisterAllPushTokens(userId: string): Promise<void> {
  await db
    .update(pushNotificationTokens)
    .set({ isActive: false })
    .where(eq(pushNotificationTokens.userId, userId));
}

export async function sendPushNotification(
  userId: string,
  payload: PushNotificationPayload
): Promise<{ sent: number; failed: number; errors: string[] }> {
  // Get all active push tokens for the user
  const tokens = await db.query.pushNotificationTokens.findMany({
    where: and(
      eq(pushNotificationTokens.userId, userId),
      eq(pushNotificationTokens.isActive, true)
    ),
  });

  if (tokens.length === 0) {
    console.warn('[push] no active tokens', { userId });
    return { sent: 0, failed: 0, errors: [] };
  }

  console.log('[push] dispatching', {
    userId,
    tokenCount: tokens.length,
    platforms: tokens.map((t) => t.platform),
    silent: payload.silent === true,
  });

  const results: SendPushResult[] = [];

  for (const tokenRecord of tokens) {
    let result: SendPushResult;

    switch (tokenRecord.platform) {
      case 'ios':
        result = await sendToApns(tokenRecord.token, payload, tokenRecord.id);
        break;
      case 'android':
        result = await sendToFcm(tokenRecord.token, payload, tokenRecord.id);
        break;
      case 'web':
        // TODO: Implement Web Push when PWA push is added
        result = {
          success: false,
          tokenId: tokenRecord.id,
          error: 'Web push not yet implemented',
        };
        break;
      default:
        result = {
          success: false,
          tokenId: tokenRecord.id,
          error: `Unknown platform: ${tokenRecord.platform}`,
        };
    }

    results.push(result);

    // Handle token cleanup for invalid tokens
    if (result.shouldRemoveToken) {
      await db
        .update(pushNotificationTokens)
        .set({ isActive: false })
        .where(eq(pushNotificationTokens.id, tokenRecord.id));
    } else if (result.serverFault) {
      // The send never reached a verdict about this device — an unset
      // FCM_SERVICE_ACCOUNT_JSON, a refused mint, an outage. Counting these
      // would deactivate every Android token after five notifications while the
      // secret is simply missing, which is the state .env.example documents as
      // the safe default, and fixing the secret would not bring them back.
      console.warn('[push] server-side failure, not counted against the token', {
        tokenId: tokenRecord.id,
        platform: tokenRecord.platform,
        error: result.error,
      });
    } else if (!result.success) {
      // Track failed attempts
      const failedAttempts = parseInt(tokenRecord.failedAttempts || '0', 10) + 1;
      await db
        .update(pushNotificationTokens)
        .set({
          failedAttempts: String(failedAttempts),
          lastFailedAt: new Date(),
          // Deactivate after 5 consecutive failures
          isActive: failedAttempts < 5,
        })
        .where(eq(pushNotificationTokens.id, tokenRecord.id));
    } else {
      // Reset failed attempts on success and update lastUsedAt
      await db
        .update(pushNotificationTokens)
        .set({
          failedAttempts: '0',
          lastFailedAt: null,
          lastUsedAt: new Date(),
        })
        .where(eq(pushNotificationTokens.id, tokenRecord.id));
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const errors = results.filter((r) => r.error).map((r) => r.error!);

  return { sent, failed, errors };
}

export async function getUserPushTokens(userId: string) {
  return db.query.pushNotificationTokens.findMany({
    where: and(
      eq(pushNotificationTokens.userId, userId),
      eq(pushNotificationTokens.isActive, true)
    ),
    columns: {
      id: true,
      platform: true,
      deviceId: true,
      deviceName: true,
      createdAt: true,
      lastUsedAt: true,
    },
  });
}
