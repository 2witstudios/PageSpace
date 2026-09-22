# Sign in with PageSpace from a native app

A native app signs a PageSpace user in with four HTTP calls and the system browser. No SDK is
required, no secret is involved, and the app never sees the user's password or holds a key. This
guide uses a Swift iOS app with the redirect URI `swipesend://callback` as the worked example; the
same calls work from Android, desktop or any other native stack.

It is OAuth 2.1 authorization code with PKCE (RFC 6749 §4.1, RFC 7636) for a **public client**:

1. **Discovery** — read the server's endpoints.
2. **Authorize** — open the authorize URL in the system browser; the user signs in and approves;
   PageSpace redirects to `swipesend://callback?code=…&state=…`.
3. **Token** — exchange the code (plus the PKCE verifier) for an access token and a refresh token.
4. **Refresh** — trade the refresh token for a new pair before the access token expires.

## Before you start

Register the app with PageSpace to get a `client_id`, and register the redirect URI exactly:
`swipesend://callback`. A native app uses a private-use URI scheme it owns (RFC 8252 §7.1), e.g.
`swipesend://callback` or `com.example.app://oauth/callback`; PageSpace matches it exactly, with no
wildcards, query or fragment. Register the scheme itself with the OS (on iOS, `CFBundleURLTypes`).

Pick the scopes:

| Scope | Grants |
|---|---|
| `profile` | The user's `id`, `name`, `email` and `image` from `GET /api/auth/me`. No content. |
| `drive:<driveId>:member` (or `:admin`, `:role:<roleId>`, or bare `drive:<driveId>`) | That one drive, at that role. Nothing outside it. |
| `offline_access` | A refresh token. Without it there is no refresh token and the session ends when the 15-minute access token does. |

SwipeSend asks for `profile offline_access` plus the drive it writes to.

## 1. Discovery

```http
GET https://pagespace.ai/.well-known/oauth-authorization-server
```

```json
{
  "issuer": "https://pagespace.ai",
  "authorization_endpoint": "https://pagespace.ai/api/oauth/authorize",
  "token_endpoint": "https://pagespace.ai/api/oauth/token",
  "revocation_endpoint": "https://pagespace.ai/api/oauth/revoke",
  "device_authorization_endpoint": "https://pagespace.ai/api/oauth/device_authorization",
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["account", "profile", "offline_access", "manage_keys", "drive:*"]
}
```

Use `authorization_endpoint`, `token_endpoint` and `revocation_endpoint` from here. Treat a
response without them as an error; do not fall back to guessed paths.

## 2. Authorize (system browser)

Generate, per sign-in:

- a **code verifier**: 32 random bytes, base64url-encoded without padding (43 characters);
- the **code challenge**: `BASE64URL(SHA256(verifier))`, no padding;
- a **state**: 32 random bytes, base64url-encoded. Keep the verifier and the state in memory (or
  the keychain) until the callback arrives.

Open:

```text
https://pagespace.ai/api/oauth/authorize
  ?response_type=code
  &client_id=YOUR_CLIENT_ID
  &redirect_uri=swipesend%3A%2F%2Fcallback
  &scope=profile%20offline_access%20drive%3AYOUR_DRIVE_ID%3Amember
  &state=STATE
  &code_challenge=CHALLENGE
  &code_challenge_method=S256
```

in the system browser — on iOS, `ASWebAuthenticationSession` with `callbackURLScheme: "swipesend"`.
Never an embedded web view: the user's PageSpace session and passkeys live in the system browser,
and PageSpace's sign-in page is the only place credentials are ever entered.

The user signs in on PageSpace if needed, sees your app's name and what it asks for, and approves
(a `drive:*` grant also asks them to confirm with a step-up check). PageSpace then redirects to:

```text
swipesend://callback?code=ps_ac_…&state=STATE
```

or, if they declined, `swipesend://callback?error=access_denied&state=STATE`.

**Check `state` first.** If it is missing, repeated, or not the one you generated, discard the
callback — it did not come from a sign-in your app started. Only then read `code` or `error`.
`error` is one of RFC 6749 §4.1.2.1's codes (`access_denied`, `invalid_scope`, …).

```swift
import AuthenticationServices
import CryptoKit

func base64URL(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func randomBase64URL(byteCount: Int = 32) -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    _ = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
    return base64URL(Data(bytes))
}

let verifier = randomBase64URL()
let challenge = base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
let state = randomBase64URL()

var components = URLComponents(string: "https://pagespace.ai/api/oauth/authorize")!
components.queryItems = [
    URLQueryItem(name: "response_type", value: "code"),
    URLQueryItem(name: "client_id", value: clientId),
    URLQueryItem(name: "redirect_uri", value: "swipesend://callback"),
    URLQueryItem(name: "scope", value: "profile offline_access drive:\(driveId):member"),
    URLQueryItem(name: "state", value: state),
    URLQueryItem(name: "code_challenge", value: challenge),
    URLQueryItem(name: "code_challenge_method", value: "S256"),
]

let session = ASWebAuthenticationSession(url: components.url!, callbackURLScheme: "swipesend") { url, error in
    guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
    let states = items.filter { $0.name == "state" }
    guard states.count == 1, states[0].value == state else { return } // forged or replayed: discard
    if let code = items.first(where: { $0.name == "code" })?.value {
        exchange(code: code, verifier: verifier)
    }
}
session.presentationContextProvider = self
session.start()
```

## 3. Token

```http
POST https://pagespace.ai/api/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=ps_ac_…
&redirect_uri=swipesend%3A%2F%2Fcallback
&client_id=YOUR_CLIENT_ID
&code_verifier=VERIFIER
```

No `client_secret` — there is none. `redirect_uri` must be the same one the authorize request
carried. The code is single-use and short-lived; exchange it immediately.

```json
{
  "access_token": "ps_at_…",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "ps_rt_…",
  "scope": "profile offline_access drive:YOUR_DRIVE_ID:member"
}
```

- `scope` is what the user actually granted; it may be narrower than what you asked for.
- `refresh_token` is present only when the grant included `offline_access`.
- Store both tokens in the keychain. Compute `expiresAt = now + expires_in` yourself.

Call the API with `Authorization: Bearer ps_at_…`, starting with who signed in:

```http
GET https://pagespace.ai/api/auth/me
Authorization: Bearer ps_at_…
```

```json
{ "id": "…", "name": "Maya", "email": "maya@example.com", "image": null }
```

## 4. Refresh

Refresh shortly before `expiresAt` (PageSpace's own clients refresh 60 seconds early), not after a
401:

```http
POST https://pagespace.ai/api/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=ps_rt_…
&client_id=YOUR_CLIENT_ID
```

The answer has the same shape as step 3, with a **new** refresh token. Refresh tokens rotate: the
old one is spent the moment this call succeeds, so write the new pair to the keychain **before**
using the new access token. A spent refresh token is refused (`400 invalid_grant`); presented more
than 30 seconds after it was rotated, it is also treated as theft and revokes the whole sign-in.
That includes a refresh whose **response** was lost in transit: the server rotated the token, the
app never saw the new one. Today there is no recovery from that — sign in again; never hold on to
and later replay a refresh token that may already have been spent.

How to read a failed refresh (ADR 0003):

| Response | Meaning | Do |
|---|---|---|
| The request never left (DNS failure, no connection, TLS error), `429`, `5xx` | Transient; the token was not spent. A `429` body carries `retryAfter` (seconds). | Retry later with backoff. Keep the stored refresh token. |
| The connection dropped or timed out **after** the request was sent | Unknown: the server may have rotated the token. | Do not replay it later. At most one immediate retry (refused harmlessly if the token was spent); if refused, sign in again. |
| Any other `4xx` (e.g. `400` `invalid_grant`, `invalid_request`) | Definitive: revoked, expired, replayed or refused. | Delete the stored tokens; sign in again. |

## Signing out

```http
POST https://pagespace.ai/api/oauth/revoke
Content-Type: application/x-www-form-urlencoded

token=ps_rt_…
&client_id=YOUR_CLIENT_ID
```

Revoking the refresh token ends the whole sign-in. The endpoint answers `200` whether or not the
token was live (RFC 7009), so delete the stored tokens regardless. The user can also disconnect
your app from **Settings → Account → Connected Apps** in PageSpace; your next refresh then fails
with `invalid_grant`.

## From a TypeScript app (React Native, Capacitor, Electron)

The same four calls are exported by `@pagespace/sdk`; the app keeps the verifier and state in its
own secure storage while the system browser is open:

```ts
import {
  buildAuthorizeUrl,
  createTokenEndpointRefresh,
  deriveCodeChallenge,
  discoverMetadata,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  parseCallback,
} from '@pagespace/sdk';

const BASE_URL = 'https://pagespace.ai';
const CLIENT_ID = 'your-client-id';
const REDIRECT_URI = 'swipesend://callback';

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function signIn(openSystemBrowser: (url: string) => Promise<string>) {
  const metadata = await discoverMetadata(BASE_URL); // 1. discovery

  const codeVerifier = generateCodeVerifier(randomBytes(32));
  const state = generateCodeVerifier(randomBytes(32));
  const authorizeUrl = buildAuthorizeUrl({
    baseUrl: BASE_URL,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scope: 'profile offline_access',
    state,
    codeChallenge: await deriveCodeChallenge(codeVerifier),
  });
  const callbackUrl = await openSystemBrowser(authorizeUrl); // 2. authorize

  const callback = parseCallback(callbackUrl, state);
  if (!callback.ok) throw new Error(`Sign-in failed: ${callback.error.reason}`);

  const tokens = await exchangeAuthorizationCode({
    tokenEndpoint: metadata.tokenEndpoint,
    clientId: CLIENT_ID,
    code: callback.code,
    redirectUri: REDIRECT_URI,
    codeVerifier,
  }); // 3. token

  const refresh = createTokenEndpointRefresh({ tokenEndpoint: metadata.tokenEndpoint, clientId: CLIENT_ID }); // 4. refresh
  return { tokens, refresh };
}
```
