# PageSpace Android

Capacitor wrapper around the web app, mirroring `apps/ios`.

> **Scope of this file today:** why the Capacitor config diverges from the iOS one, what deep
> links ship and what is deferred, and the server-side push requirements. Client-side setup — the
> runtime permission prompt, token registration, build and signing — belongs to the Android client
> work and is not documented here yet.

## Why this config is not a copy of the iOS one

`apps/ios/capacitor.config.ts` carries a long comment about `allowNavigation` and `errorPath`,
added when the iOS shell bricked in PR #2010. Android sets those two keys for different reasons,
splits `server.url` in a way iOS does not need to, and keeps a deliberately much shorter
`allowNavigation` list. Three divergences, in the order they matter:

### `server.url` must stay an origin — the path lives in `appStartPath`

```ts
url: 'https://pagespace.ai',
appStartPath: '/dashboard',
```

Not cosmetic. `Bridge.setAllowedOriginRules()` puts `getServerUrl()` **verbatim** into the set
`MessageHandler` hands to `WebViewCompat.addWebMessageListener`, and that API takes origin rules —
`scheme://host[:port]`. A `url` carrying `/dashboard` is not one, and the catch for a rejected rule
is `webView.addJavascriptInterface(this, "androidBridge")`, which enforces no origin restriction at
all. Put the path back into `url` and the `allowNavigation` allowlist below may stop meaning
anything.

`Bridge` appends `appStartPath` *after* the `server.url` branch, so `appUrl` is still
`https://pagespace.ai/dashboard` and the app still bypasses the landing page. The other
`getServerUrl()` consumers are fine with an origin: `WebViewLocalServer.isMainUrl`/`isAllowedUrl`
only null-check it, and `CapacitorCookieManager.getSanitizedDomain` wants a cookie domain.

The rejection is documented, not inferred. `WebViewCompat.addWebMessageListener`'s javadoc gives
the rule grammar as `SCHEME "://" [ HOSTNAME_PATTERN [ ":" PORT ] ]` — which has no path
production, so `https://pagespace.ai/dashboard` is not expressible as a rule — and declares
`@throws IllegalArgumentException If one of the allowedOriginRules is invalid`.

What is still unobserved is the runtime consequence: that Capacitor's catch is therefore taken and
`addJavascriptInterface` really does replace the origin-scoped listener on a device. Worth
confirming during device verification, and worth an upstream report to Capacitor if so, since any
app with a path in `server.url` inherits it silently.

### The iOS brick does not reproduce on Android

iOS failed because `WebViewDelegationHandler.swift` falls back to a raw string-prefix test of the
target URL against `server.url` — which carries the `/dashboard` path — so a top-level navigation
to any other path failed it and was handed to Safari, leaving no document. Android's equivalent,
`Bridge.launchIntent()`, compares host and scheme only:

```java
Uri appUri = Uri.parse(appUrl);
if (
    !(appUri.getHost().equals(url.getHost()) && url.getScheme().equals(appUri.getScheme())) &&
    !appAllowNavigationMask.matches(url.getHost())
) { /* ACTION_VIEW to the system browser */ return true; }
```

`https://pagespace.ai/signin` matches on both, so it already stayed in the WebView with no
`allowNavigation` at all. The apex entry in the Android config states the app's own origin; it does
not change behaviour.

### `errorPath` is a real gap, and it is the reason the config changed

`BridgeWebViewClient.onReceivedError` and `onReceivedHttpError` load `bridge.getErrorUrl()` for
main-frame requests. With no `errorPath` configured that returns `null`, so a failed load left the
WebView on its own error page. With it, Android serves `https://localhost/index.html` from the
bundled assets — `public/index.html`, which carries the Retry button.

Note that page gets **no Capacitor bridge**: `Bridge.loadWebView()` scopes
`addDocumentStartJavaScript` to the `server.url` origin, so `Capacitor` and every plugin are
undefined there. It uses plain DOM APIs only, and must keep doing so.

### An `allowNavigation` entry grants the native plugin bridge

This is the important divergence. On Android the list is not just a navigation allowlist:
`Bridge.setAllowedOriginRules()` folds every entry into `allowedOriginRules`, and
`MessageHandler.java:36` passes that set to
`WebViewCompat.addWebMessageListener(webView, "androidBridge", ...)`. Any main-frame document from
a listed origin can then call `androidBridge.postMessage()`, which reaches
`Bridge.callPluginMethod()` and every registered plugin — including `PageSpaceKeychain`, backed by
EncryptedSharedPreferences.

So Android lists `pagespace.ai` and nothing else:

- **`accounts.google.com` / `appleid.apple.com`** are not listed, though iOS lists them. Allowing
  them would load a provider consent page in the privileged WebView. The apparent benefit was a
  visible `disallowed_useragent` failure instead of a silent wrong-cookie-jar one when the web
  OAuth fallback fires — not worth a native-trust grant to a third party. Provider pages belong in
  a Custom Tab with a bound callback.
- **`*.pagespace.ai`** is not listed either. `allowNavigation` governs top-level navigations only
  (subresources from `assets.pagespace.ai` and friends never consult it), and the shell loads
  `/dashboard` and stays there, so the wildcard enabled no navigation anyone could name while
  granting the bridge to every subdomain that exists or ever will, tenant hosts included.

**iOS has the same exposure and worse scoping**, and it is shipped: `JSExport.swift:20-21`
registers the bridge as `WKUserScript(..., forMainFrameOnly: true)` on the WebView's
`userContentController`, with no origin scoping at all, so it applies to every main-frame document
the WebView loads. Changing that is separate work, tracked on the Android parity epic.

## Deep links: what ships, and what is deliberately deferred

`AndroidManifest.xml` registers **one** deep-link intent filter: the `pagespace://` custom
scheme, mirroring iOS's `CFBundleURLSchemes`. It needs no domain verification and no server-side
file, so the registration takes effect as soon as the app is installed, on every supported API
level.

**Registration is not ownership.** Custom schemes are not exclusive on Android: any other
installed app can register `pagespace://` as well and be offered in the disambiguation chooser, or
be set as the user's default handler. That no browser competes for the scheme does not mean no app
does — which is why the scheme must not be treated as an authentication return channel until the
handoff it carries is bound to the app that started the flow (see below).

It is **groundwork, not a live path**. `pagespace://auth-exchange?code=…` is what the Google and
Apple OAuth callback routes redirect to, but only on their `platform === 'ios'` branch, and
`apps/web/src/lib/auth/oauth-state.ts` types the platform as `z.enum(['web', 'desktop', 'ios'])`
— `'android'` is not a value it can take, so no server path emits a `pagespace://` redirect for
Android today. (`/api/auth/google/native` does accept `'android'`, but it returns JSON to the
native plugin rather than a deep link.) Teaching that path about Android belongs to the epic's
native auth phase; registering the scheme now means the manifest will not be the blocker then.

**Verified App Links for `https://pagespace.ai` are NOT registered.** Two prerequisites are
missing, and the filter is a regression rather than groundwork until both land.

### Prerequisite 1 — assetlinks.json, which needs a release signing certificate

`/.well-known/assetlinks.json` must be served from `pagespace.ai` carrying the SHA-256
fingerprint of the **release** signing certificate:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "ai.pagespace.android",
    "sha256_cert_fingerprints": ["<release cert SHA-256, colon-separated hex>"]
  }
}]
```

No release keystore exists — signing and Play Console setup are outside the Android parity epic —
so **no build we could ship can be verified**. This is a statement about release-signed artifacts,
not about the mechanism: a debug build can be verified locally against a debug-fingerprint
assetlinks file, and that workflow is documented below. What is missing is the release certificate,
and with it any possibility of verification on a user's device.

### Prerequisite 2 — link routing in the web app

Nothing listens for the `@capacitor/app` plugin's `appUrlOpen` event, on **either** platform. A
captured link therefore opens the app at its configured start URL (`server.url` + `appStartPath`,
so `/dashboard`), not at the linked path: the invite token or auth callback code in the URL is
silently dropped.

### Why `autoVerify` alone is not enough here

`android:autoVerify="true"` is often described as making an unverified filter degrade safely to
the browser. That is true only on **API 31+**, and it is a behaviour of the *device's* platform
version, not of `targetSdk`:

| Device API level | Filter present, verification fails |
|---|---|
| 31+ (Android 12+) | App is not a candidate; link opens in the browser. Safe. |
| 23–30 (Android 6–11) | Filter stays eligible; PageSpace appears in the disambiguation chooser. |

`minSdkVersion` is 23, so the second row is in scope. On those devices a user who picks PageSpace
from the chooser lands on `/dashboard` with the token gone — strictly worse than the browser, and
for no gain, since no shipped build can be verified. Hence: deferred, not shipped. (A debug build
can be verified locally, but that changes nothing for a user's device, which is what the filter
would affect.)

Sourcing, since the two rows are not equally well documented. The 23–30 row follows from the
docs: unverified deep links are "subject to the system disambiguation dialog", and "on Android 11
(API level 30) and lower, the system establishes your app as the default handler for the specified
URL patterns only if it finds a matching Digital Asset Links file for all hosts in the manifest" —
i.e. failing verification costs you *default* status, not candidacy. The 31+ row is the
well-established behaviour change that Codex review identified; I did not find it stated in one
quotable sentence in the official docs.

That gap does not affect the decision, which is why it is recorded rather than chased: **deferring
is the safe choice under either reading.** If 31+ really does drop the app from resolution, the
filter is inert and costs nothing to omit; if it does not, the filter would be actively harmful on
every supported version. The filter only becomes worth adding once verification can actually
succeed — which is prerequisite 1.

### The filter to add, once both prerequisites are met

Paths mirror `apps/web/public/.well-known/apple-app-site-association` so the two platforms capture
the same links. Widening beyond these paths should still wait on prerequisite 2 — whole-host
capture would strand users on `/dashboard` from every marketing, blog, or docs link.

A third prerequisite applies to the auth-callback paths specifically: `/api/auth/desktop/exchange`
authenticates possession of the one-time code alone, with no PKCE verifier and no binding to the
app that began the flow, so whichever handler receives the code can redeem it for a session. That
must be bound before any return channel — App Link or custom scheme — is treated as an
authentication path.

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="pagespace.ai" android:pathPrefix="/auth/callback/" />
    <data android:scheme="https" android:host="pagespace.ai" android:pathPrefix="/api/auth/callback/" />
    <data android:scheme="https" android:host="pagespace.ai" android:pathPrefix="/invite/" />
    <data android:scheme="https" android:host="pagespace.ai" android:pathPrefix="/join/" />
</intent-filter>
```

To exercise it before a release certificate exists, serve the same `assetlinks.json` with the
**debug** keystore's fingerprint:

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android
adb shell pm verify-app-links --re-verify ai.pagespace.android
adb shell pm get-app-links ai.pagespace.android
```

Both `pm` subcommands arrived with the API 31 verification system, so this checks the top row of
the table above. Confirming the API 23–30 behaviour — that an unverified filter stays chooser-
eligible — needs an older device or emulator image, and is the row that matters for the decision
to defer.

## Server-side push requirements (production `pagespace-web`)

FCM sending needs one secret set on the Fly web app:

- `FCM_SERVICE_ACCOUNT_JSON` — the whole service account JSON on a single line, from the Firebase
  console → Project settings → Service accounts → Generate new private key.

The Firebase project id is read out of that JSON, so there is no second variable to keep in sync
with it. That also means **cross-project sending is not supported here**: FCM HTTP v1 does allow it
when the sender has `roles/firebasecloudmessaging.admin` on the target project and the request URL
names that target, but this sender derives the URL project from the credential itself and has no
separate target setting.

In practice the service account must therefore come from the project the app is built against,
`pagespace-f328e` (`apps/android/android/app/google-services.json`). One from a different project
will be rejected — `SENDER_ID_MISMATCH` if it is a sender mismatch, a project-level `NOT_FOUND` if
the project simply does not match — on every send.

Like `APNS_PRIVATE_KEY`, the `private_key` inside the JSON keeps its linebreaks as literal `\n` so
the value stays single-line; the sender unescapes them before signing.

Unlike the APNs path, there is no sandbox/production host split — FCM has one endpoint, so
`NODE_ENV` does not affect Android delivery.

**Left unset, Android sends fail closed:** each send reports a configuration error naming the
missing field, iOS and web deliveries in the same dispatch still go out, and no device is
deactivated for it. It is safe to deploy without the secret; Android simply receives nothing.

Push is driven from the same web layer as iOS (`/api/notifications/push-tokens` for registration),
and the server sends via `packages/lib/src/notifications/push-notifications.ts` — an OAuth2 access
token minted from the service account, then FCM HTTP v1.

### Verifying it works

Once the secret is set, three sends confirm the whole path:

1. a visible notification — should appear in the tray
2. a silent one (a badge sync) — the server sends it data-only, with no `notification` block, so
   FCM will not display it of its own accord. Whether anything reaches the tray from there is the
   client handler's business, not this sender's; the server-side half of the claim is what the
   tests pin.
3. one to a registration token FCM rejects **with a token-specific verdict** — an `FcmError` detail
   of `UNREGISTERED`, or a `BadRequest` naming `message.token`. Only those two deactivate the row.
   An arbitrarily corrupted string is not a reliable fixture: FCM may answer with a bare
   `INVALID_ARGUMENT` carrying neither, which by design leaves the row active. The dependable
   version of this check is to register a real device, uninstall the app, and send again.

Only a token-specific verdict from FCM deactivates a device. Credential, project, quota, outage
and malformed-message rejections never count against a phone, however many times they occur.
