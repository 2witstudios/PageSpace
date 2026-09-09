# PageSpace Android App

Capacitor 7 wrapper around the PageSpace web app, mirroring `apps/ios`. **Not distributed.** There
is no release build, no Play Console listing, and no release keystore; the last artifact was a
debug APK on 2026-03-23. What has landed since is the Android Parity Epic (PRs #2500, #2501,
#2552, #2557, #2558, #2559), and **none of it has been run on a device** — see "Device
verification" below before trusting any behavioural claim in this file.

- **Application ID / namespace:** `ai.pagespace.android` (`android/app/build.gradle`)
- **Capacitor app ID:** `ai.pagespace.android` (`capacitor.config.ts`)
- **Firebase project:** `pagespace-f328e` (`android/app/google-services.json`)
- **SDK levels:** `minSdk 23`, `compileSdk`/`targetSdk 36` (`android/variables.gradle`)
- **Signing:** debug keystore only. No release signing config exists in `build.gradle`.
- **Native plugin of our own:** `PageSpaceSecureStoragePlugin.java`, registered in
  `MainActivity.java` under the name `PageSpaceKeychain` (same name as the iOS Swift plugin, so
  the web layer's `keychain-plugin.ts` binding serves both)

## Architecture

This is a **remote-loading** app, like iOS. The WebView loads the live site directly:

- `server.url = https://pagespace.ai` with `appStartPath = /dashboard` — the split is deliberate
  and Android-specific; see "`server.url` must stay an origin" below. iOS carries the path in
  `server.url` and must not be copied here.
- `webDir: ./public` is only the offline fallback shell (`errorPath: index.html`, the Retry
  screen).
- Because behaviour comes from the live site, most product changes ship without an app update.
  A new build is needed only when native config changes: version bump, manifest, permissions,
  plugins, Gradle dependencies, icons/splash, or a Capacitor/plugin upgrade.

Everything the shell *does* natively is driven from the shared web layer through the capability
table in `apps/web/src/lib/capacitor-bridge.ts`: the storage, auth, push and badge paths ask
`hasNativeCapability('secureStore' | 'nativeAuth' | 'push' | 'badge')` rather than comparing the
platform to `'ios'`, and Android answers yes to all four (Apple sign-in excepted — see below).
`isIOS()` still exists and is still used where behaviour genuinely is iOS-only — the badge hook's
authorization-option gate, iPad layout heuristics — so a remaining `=== 'ios'` is not automatically
a parity bug; ask whether Android would want the same branch. Adding a capability to Android is a
one-line table edit, not a call-site sweep.

## Building locally

Prereqs: Android Studio (or the command-line SDK) with an SDK 36 platform, a JDK 17+, and `bun`
at the repo root. **Run `bun install` first** — the Capacitor packages live under
`apps/android/node_modules`, not the workspace root.

```bash
# From the repo root — build the web app, then sync native
bun run --cwd apps/android build:full   # builds `web`, then `cap sync android`
# or, if the web build is current:
bun run --cwd apps/android build        # `cap sync android` only

bun run --cwd apps/android dev          # `cap open android` — opens Android Studio
bun run --cwd apps/android run          # `cap run android` — build + install on a connected device/emulator
bun run --cwd apps/android typecheck    # `tsc --noEmit` over capacitor.config.ts (also runs in CI)
```

`cap sync android` does three things you should know about: it regenerates
`android/app/src/main/assets/capacitor.config.json` from `capacitor.config.ts` (gitignored — a
stale copy ships whatever it last held, so **sync immediately before every build**), it rewrites
`android/capacitor.settings.gradle` and `android/app/capacitor.build.gradle` from the plugin list
in `package.json` (both are committed and currently **stale** — neither lists
`@capawesome/capacitor-badge` yet, so a Gradle build without a prior sync compiles no badge plugin
and `Badge.set()` rejects at runtime), and it copies `public/` into the assets dir.

A plain Gradle build from `android/` (`./gradlew assembleDebug`) works after a sync and produces
`android/app/build/outputs/apk/debug/app-debug.apk`, signed with `~/.android/debug.keystore`.

### What CI checks — and what it does not

Since Phase E, `apps/android` and `apps/ios` each have a `typecheck` script and a
package-specific override in the root `turbo.json` (`"@pagespace/android#typecheck": { "dependsOn": [] }`)
so `bun run typecheck` covers `capacitor.config.ts` **without** dragging web's Next.js build into
the graph (the app devDepends on `web`, so the default `^build` dependency would). A guard test in
`apps/web` — `src/lib/__tests__/capacitor-allow-navigation.guard.test.ts` — pins the
`allowNavigation` and `server.url` invariants described below for both platforms.

That is the whole of it. **Nothing in CI compiles the Java, parses the manifest, runs Gradle, or
installs an APK.** A change to `MainActivity.java`, `PageSpaceSecureStoragePlugin.java`,
`AndroidManifest.xml` or any Gradle file is checked by the reviewer's eyes and, later, by a
device. Validate the manifest as XML at least (`xmllint --noout
android/app/src/main/AndroidManifest.xml`).

## Versioning

`android/app/build.gradle`, `defaultConfig`:

- `versionCode` — Android's build number, an integer that must strictly increase per upload to
  Play. Currently **2** (Phase E bumped it from the 2026-03-23 debug APK's `1`).
- `versionName` — the user-facing version. Currently **`1.4`**, deliberately tracking the iOS
  `MARKETING_VERSION` so both stores show one product version; bump the two together.

Neither is read from `capacitor.config.ts`; there is no equivalent of iOS's `$(MARKETING_VERSION)`
indirection.

## Native capabilities — what each phase wired, and how

| Capability | Native side | Web side | Phase / PR |
|---|---|---|---|
| Secure storage | `PageSpaceSecureStoragePlugin.java` over `EncryptedSharedPreferences` (`androidx.security:security-crypto:1.1.0-alpha06`, an alpha) | `apps/web/src/lib/auth/platform-storage/android-storage.ts` (`AndroidStorage`), selected by `hasNativeCapability('secureStore')` | A — #2557 |
| Native Google sign-in | `@capgo/capacitor-social-login`, Android SDK; `androidClientId` in `capacitor.config.ts` | `apps/web/src/lib/native-google-auth.ts`, initialised with `webClientId = NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID` (the ID token's audience is the web client, which `/api/auth/google/native` already accepts) | B — #2559 |
| Sign in with Apple | **none** — Android has no native Apple SDK | `supportsNativeAuthProvider('apple')` is false on Android; the button falls to web OAuth, which leaves the app for the external browser and drops the session in the wrong cookie jar. **Known broken on Android**, not a regression; tracked on the "Mobile OAuth return-channel hardening" epic in the dev drive | B — #2559 |
| Bearer auth + CSRF | — | `buildAuthCredentials` in `auth-fetch.ts` mirrors the server's rule: bearer if a token exists, else cookie credentials with `X-CSRF-Token` on mutations. Before #2559 every Android mutation answered 403 `CSRF_TOKEN_MISSING` | B — #2559 |
| Push registration | `POST_NOTIFICATIONS` in the manifest; Firebase Messaging via the BoM in `build.gradle` | `usePushNotifications.ts`, gated on `capabilities.push`; token POSTs to `/api/notifications/push-tokens` with `platform: 'android'` | D — #2558 |
| FCM sending | — | `packages/lib/src/notifications/push-notifications.ts`, `case 'android'`: OAuth2 token from `FCM_SERVICE_ACCOUNT_JSON`, FCM HTTP v1 | — #2501 |
| App-icon badge | `@capawesome/capacitor-badge` (added to `package.json`; Gradle files regenerate on sync) | `useNativeBadgeSync.ts` (formerly `useIosBadgeSync`) | D — #2558 |
| Deep links | `pagespace://` intent filter (inert); **no** https App Links filter | `DeepLinkHandler.tsx` + `deep-links.ts` (cross-platform, from #2569) | C — #2552 |
| Error shell | `errorPath: index.html` → `public/index.html` Retry screen | — | C — #2552 |

Details for storage: `AndroidStorage` reports `usesBearer() === true`; a session written by the
web sign-in flow inside the WebView (before native sign-in existed) lives in `localStorage`, and
the adapter falls back to it and adopts its device binding rather than stranding it. The plugin
`call.reject`s if `EncryptedSharedPreferences.create()` threw at load, and `storeSession` /
`getStoredSession` propagate that as an error instead of silently persisting nothing; every
bridge read is bounded by a 3-second timeout. The device id is `pagespace_device_id` in
`@capacitor/preferences`, the same key iOS uses.

Details for native Google: **this is the only route to a Google session in the Android shell**,
not an optimisation. Google One Tap returns early under Capacitor, the web OAuth handoff cookie
lands in the external browser, and magic link never mints a device token off desktop. If the
plugin fails to register on a device there is no working alternative. There is deliberately no
fall-through from a failed native attempt to web OAuth (`useOAuthSignIn.ts`), because there is no
working web OAuth inside the shell to fall through to.

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

That page has no `window.Capacitor`, and it is worth knowing that this holds for two *different*
reasons depending on the device, because only one of them is about origin scoping:

- **WebView supports `DOCUMENT_START_SCRIPT`:** `Bridge.loadWebView()` registers the wrapper via
  `addDocumentStartJavaScript` scoped to the `server.url` origin, and sets the injector to null.
  Nothing is injected at `https://localhost`.
- **WebView does not:** the injector stays live and `WebViewLocalServer` *does* inject the runtime
  into locally-served HTML — at `handleLocalRequest` line 449, `ext.equals(".html") && jsInjector
  != null`. That branch is never reached for this page, because `isErrorUrl()` is tested at line
  374 and returns a raw, non-injected stream first.

The second one is a load-bearing coincidence, so treat it as a constraint: the exemption is keyed
on the request URL matching `bridge.getErrorUrl()` exactly. Serve this fallback from any other
local path and legacy WebViews *will* inject the Capacitor runtime into it.

**How the app itself gets its wrapper on those legacy WebViews**, since it is not obvious and is
worth knowing before anyone touches `server.url`: `initWebView()` puts the `server.url` authority
into `WebViewLocalServer`'s `authorities`, and with `server.url` set `isAllowedUrl()` is
unconditionally true, so the top-level `pagespace.ai` HTML request takes `handleProxyRequest` —
fetched through `HttpURLConnection`, with cookies copied to and from `CookieManager` by hand, and
the runtime injected into the response. Where `DOCUMENT_START_SCRIPT` is supported the injector is
null and that method returns null, leaving the WebView's own network stack in charge.

Note this is driven by `server.url`, **not** by the `pagespace.ai` entry in `allowNavigation`:
`initWebView()` runs at `Bridge.java:223` and adds that authority, before `setAllowedOriginRules()`
at line 224 adds the `allowNavigation` hosts. Removing the apex entry would not change the network
path or the injection. **It is not, however, outside the native bridge**, and it would be a mistake
to treat it as a sandbox: `Bridge.setAllowedOriginRules()` adds `scheme://hostname` —
`https://localhost` — to the allowed-origin set *unconditionally*, before it looks at
`allowNavigation` at all, so `MessageHandler` exposes `androidBridge` on this origin. Code that
knows the message protocol can call registered plugins directly.

The retry page uses plain DOM APIs only and should keep doing so, but that is a discipline, not a
boundary the platform enforces.

### An `allowNavigation` entry grants the native plugin bridge

This is the important divergence. On Android the list is not just a navigation allowlist:
`Bridge.setAllowedOriginRules()` folds every entry into `allowedOriginRules`, and
`MessageHandler.java:36` passes that set to
`WebViewCompat.addWebMessageListener(webView, "androidBridge", ...)`. Any main-frame document from
a listed origin can then call `androidBridge.postMessage()`, which reaches
`Bridge.callPluginMethod()` and every registered plugin — including `PageSpaceKeychain`, backed by
EncryptedSharedPreferences.

The full set is wider than `allowNavigation`, which matters if you are auditing bridge access.
`setAllowedOriginRules()` adds, in order: `scheme://hostname` (`https://localhost`, the bundled-asset
origin — see the `errorPath` section above), then `server.url` if set, then every `allowNavigation`
entry. So `allowNavigation` is the only part *we* control, and shortening it is the only lever this
config has.

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

### Prerequisite 2 — link routing in the web app (met since PR #2569)

When Phase C shipped, nothing listened for the `@capacitor/app` plugin's `appUrlOpen` event on
either platform, so a captured link never reached the path it named. That is no longer true:
`apps/web/src/components/DeepLinkHandler.tsx` (mounted in the root layout) handles both halves —
`App.getLaunchUrl()` for a cold start, where the URL is spent before any listener exists, and the
`appUrlOpen` listener for a warm one, where `Bridge.onNewIntent` only notifies plugins and never
calls `loadUrl`. It lives in the shared web layer, so Android gets it for free the moment it
starts receiving links. Which URLs resolve to which route is
`apps/web/src/lib/navigation/deep-links.ts` — an allowlist, currently `https://pagespace.ai/invite/<token>`
only; anything else on the claimed host is handed to the browser rather than swallowed.

Two things the resolver does **not** do, both on purpose: it ignores the `pagespace://` scheme
entirely (the exchange-binding precondition above), and it does not route `/auth/callback/*` or
`/join/*`. Widen the AASA, the Android filter, and the resolver **together** — claiming a path the
resolver returns `null` for makes the link do nothing in the app, which is strictly worse than
leaving it to the browser.

The behaviour table below is therefore what a user on Android 6–11 would see **without** the
routing, and is kept because it is what makes an unverified filter harmful on those versions:

| Start | With no listener (pre-#2569) |
|---|---|
| **Cold** | The app launches and loads its start URL (`server.url` + `appStartPath`, so `/dashboard`). The linked path is dropped. |
| **Warm** (`singleTask`, app already running) | The intent arrives via `onNewIntent`; `Bridge.onNewIntent` only notifies plugins — it never calls `loadUrl` — so `AppPlugin` fires `appUrlOpen` into a void and **the WebView stays exactly where it was.** |

### Why `autoVerify` alone is not enough here

`android:autoVerify="true"` is often described as making an unverified filter degrade safely to
the browser. That is true only on **API 31+**, and it is a behaviour of the *device's* platform
version, not of `targetSdk`:

| Device API level | Filter present, verification fails |
|---|---|
| 31+ (Android 12+) | App is not a candidate; link opens in the browser. Safe. |
| 23–30 (Android 6–11) | Filter stays eligible; PageSpace appears in the disambiguation chooser. |

`minSdkVersion` is 23, so the second row is in scope. On those devices a user who picks PageSpace
from the chooser gets, per the table above, either the dashboard (cold) or no visible change at all
(warm) — with the token gone in both cases. Strictly worse than the browser, and for no gain, since
no shipped build can be verified. Hence: deferred, not shipped. (A debug build
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

Prerequisite 2 is met (above). What remains for Android is prerequisite 1: the release signing
certificate and a real `assetlinks.json`. Until those exist **Android captures nothing** — no
https intent-filter is registered.

When it does, mirror `apps/marketing/public/.well-known/apple-app-site-association` (the copy
Caddy actually serves), currently `/invite/*` and `/auth/magic-link/*`, so both platforms capture
the same links. Widening beyond these paths should still wait on prerequisite 2 — whole-host
capture would strand users on `/dashboard` from every marketing, blog, or docs link.

**Magic links reach the same wall.** The shared web layer already treats Android as a
device-bound platform: a magic link requested from the Android app is minted for this device and
emailed as `https://pagespace.ai/auth/magic-link/<token>`, and
`apps/web/src/app/auth/magic-link/[token]/page.tsx` would redeem it into the secure store exactly
as it does on iOS. But with no https intent-filter registered, **Android never receives the tap** —
Chrome opens the link and signs Chrome in with a cookie, which is what happens today and is no
worse than before. It is not fixed for Android, and it cannot be until prerequisite 1 lands; the
server and web halves are simply already in place for when it does.

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

## Client-side push: permission and registration

`POST_NOTIFICATIONS` is declared in `AndroidManifest.xml`. It has to be: on API 33+ (targetSdk is
36) it is a dangerous permission that starts out ungranted, and an *undeclared* dangerous
permission cannot be requested at all — the request resolves denied with no dialog shown. On API 32
and below the OS ignores the declaration, and `@capacitor/push-notifications` resolves
`requestPermissions()` as granted without asking.

The runtime request and the token round trip live in the shared web layer, in
`apps/web/src/hooks/usePushNotifications.ts` and `apps/web/src/components/PushNotificationManager.tsx`
— the same code iOS runs. What changed for Android is only the gate: the hook now asks
`useCapacitor().capabilities.push` (the table in `apps/web/src/lib/capacitor-bridge.ts`) instead of
comparing the platform to `'ios'`. On registration the FCM token POSTs to
`/api/notifications/push-tokens` with `platform: 'android'`, which that route has always accepted.

**A refusal is remembered.** The hook writes a `push_permission_denied` record to `localStorage`
and declines to call `requestPermissions()` again while it stands, so the dialog does not return on
every cold start. This is not redundant with the OS state: after one refusal Android reports
`'prompt-with-rationale'` from `checkPermissions()` and would still allow the ask.

The record is a cache of the OS's answer, never a second source of truth. The permission-check
effect runs once per mount, so the sync below happens on the next launch rather than the moment a
setting changes; it makes the record agree with the OS in both directions. It writes one when
`checkPermissions()` reports `denied` or `prompt-with-rationale` — the OS can be holding a refusal
this client never saw it collect, which is exactly the state of a user who refused on a build
predating the record, or one whose storage write failed — and it drops one whenever the OS reports a
state that is not holding a refusal —
`granted` (the user turned notifications on from system settings) or `prompt` (the OS has forgotten
the refusal and would ask again, which is where **Android 11+ lands after auto-revoking permissions
for an app that went unused**). `denied` and `prompt-with-rationale` both keep it. There is
therefore no manual override to re-ask: the way back is the OS's own state, so the record can never
outlive the refusal it stands for. While it does stand, `hasPreviouslyDenied` is the signal a
settings surface should use to say "enable notifications in system settings" rather than offer a
button that would do nothing.

**Not covered here: how the notification is drawn.** This work makes a push *deliverable*; what the
tray renders is separate and unverified. The manifest declares no
`com.google.firebase.messaging.default_notification_icon` or `default_notification_channel_id`
meta-data, so both the small icon and the channel fall to Firebase's defaults inside
`CommonNotificationBuilder.getOrCreateChannel` / `createNotificationInfo` (the plugin calls both —
`PushNotificationsPlugin.java:274-286`). Whether that produces a usable icon and a sensibly-named
channel on a real device is a device-verification question, and adding a monochrome notification
icon is its own asset task.

One thing that will look like a bug during verification and is not: a push arriving while the app is
in the **foreground** does nothing visible. The hook dispatches a `push:received` window event and
nothing in the app listens for it — deliberately, on both platforms, because the foreground already
has a better channel (the realtime socket drives `useNotificationStore`, which is what moves the
in-app unread count and the badge). Tapping a notification *is* wired: `PushActionHandler` listens
for `push:action` with no platform gate and routes on `data.type` / `data.pageId` / `data.driveId`,
all of which the sender populates and FCM delivers as strings.

**Badges.** `@capawesome/capacitor-badge` is now an Android dependency and `useNativeBadgeSync`
(formerly `useIosBadgeSync`) projects the unread count on both platforms. The Android badge is a
launcher feature: launchers that do not implement one reject or ignore the write, which the hook
logs and otherwise treats as a no-op. The iOS-only authorization gate inside it is conditional, not
removed — see the comment there for the one-shot option cap it defends against.

Adding that dependency leaves the generated `capacitor.settings.gradle` and
`app/capacitor.build.gradle` stale in the repo — neither lists the badge plugin yet, and until they
do it is not compiled into the APK and `Badge.set()` rejects at runtime (silently, per the above).
No separate step is needed to fix that: `cap sync android` regenerates both, and it is already the
second half of `build:full`, so the documented device-verification path
(`bun run --cwd apps/android build:full`) picks it up. The stale files only bite someone who builds
Gradle directly without syncing first.

**Not verified on a device.** Nothing here has been exercised on real hardware — there is no
release build yet. The permission dialog, the FCM token round trip and badge behaviour across
launchers are all the device-verification task's to confirm.

## Device verification — the checklist nothing has run yet

Every behavioural claim in PRs #2552, #2557, #2558 and #2559 was read off source (Capacitor 7.6.5
Java, the plugin's Java, this repo) and **not observed on hardware**. This is the list of what a
person with an Android device or emulator needs to confirm, in the order the failures would
cascade. The board task "Device verification" on the Android Parity Epic is `blocked` until this
is done; mark each line with the device, API level and build you used.

**Setup**

- [ ] `bun install`, then `bun run --cwd apps/android build:full`, then `./gradlew assembleDebug`
      from `android/`. Confirm `android/app/src/main/assets/capacitor.config.json` contains
      `"url": "https://pagespace.ai"`, `"appStartPath": "/dashboard"`, `"allowNavigation": ["pagespace.ai"]`,
      `"errorPath": "index.html"` — that is what the shell actually reads.
- [ ] Confirm `capacitor.settings.gradle` and `app/capacitor.build.gradle` now list
      `capawesome-capacitor-badge` after the sync (they are stale in git).
- [ ] Install on **one API 33+ device** (permission dialog path) and, if possible, **one API 23–30
      device or emulator** (the App Links chooser row in the table above; also the
      `POST_NOTIFICATIONS`-is-ignored path).

**Shell (Phase C, #2552)**

- [ ] Cold launch lands on `https://pagespace.ai/dashboard` (or the signin redirect), inside the
      WebView, not the browser. This is the `appStartPath` split working.
- [ ] **The bridge origin allowlist is live, not the fallback.** Two checks, from `chrome://inspect`
      on the connected device: (1) on the app's own page, `window.androidBridge` exists and
      `Capacitor.Plugins.PageSpaceKeychain` calls resolve; (2) open a page on a **non-listed**
      origin in the same WebView (e.g. navigate via an in-app link that is not intercepted, or
      load one through DevTools) and confirm `androidBridge.postMessage` is **absent or refused**
      there. If it works on a foreign origin, `MessageHandler` took its
      `addJavascriptInterface` catch — that is the finding-3 fallback, and it means the
      allowlist protects nothing. Report upstream to Capacitor if so.
- [ ] Airplane mode, cold launch: the bundled Retry screen renders (not Chrome's error page).
      Restore connectivity, tap Retry: the app loads `/dashboard`.
- [ ] Tap a `https://pagespace.ai/...` link from another app: it opens in the **browser**, with no
      disambiguation chooser, on both API rows. (No https filter is registered; this confirms it.)
- [ ] `adb shell am start -a android.intent.action.VIEW -d "pagespace://anything"` with the app
      **running**: the app comes to the foreground, stays on its current route, and nothing else
      happens (the resolver ignores the scheme). Cold: the app launches to `/dashboard`.

**Secure storage (Phase A, #2557) and auth (Phase B, #2559)**

- [ ] Native Google sign-in end to end: the native account picker appears (not a web consent
      page), the app lands authenticated, and `adb logcat` shows no `PageSpaceKeychain` rejection.
- [ ] A **mutation** after native sign-in — create a page, send a message — returns 2xx, not
      403 `CSRF_TOKEN_MISSING`.
- [ ] Force-stop and relaunch: the session survives (read from `EncryptedSharedPreferences`), with
      no visit to `/auth/signin`.
- [ ] Background the app for **more than five minutes**, foreground it: still signed in (the
      proactive refresh must not sign a live session out — the Phase B round-3/4 defect).
- [ ] Sign out: relaunch lands on `/auth/signin`, and the keychain holds no session
      (`adb shell run-as ai.pagespace.android ls shared_prefs` shows the file; its contents are
      encrypted, so judge by the relaunch).
- [ ] Sign in with **Apple**: expected to **fail** (leaves for the external browser; app stays
      signed out). Confirm that is what happens and that it fails cleanly, not with a crash.
- [ ] Magic link from an email on the device: opens in the browser, not the app (no App Links),
      and the app stays signed out — known, not a regression.

**Push and badge (Phase D, #2558)**

- [ ] API 33+: first launch after sign-in shows the notification permission dialog **once**. Deny,
      relaunch: no dialog. Enable in system settings, relaunch: registration proceeds (the
      `push_permission_denied` record is dropped when the OS reports `granted`).
- [ ] With `FCM_SERVICE_ACCOUNT_JSON` set on the server: a row for this device appears with
      `platform = 'android'`, and a mention from another account **arrives in the tray** with the
      app in the background. Note the small icon and channel name — both are Firebase defaults
      today (no `default_notification_icon` / `default_notification_channel_id` meta-data).
- [ ] Tap the notification: the app opens the referenced page (`PushActionHandler`).
- [ ] With the app in the **foreground**, a push does nothing visible — by design.
- [ ] Badge: an unread count shows on the launcher icon on a launcher that supports badges
      (Pixel Launcher, Samsung One UI); on one that does not, nothing happens and nothing errors.
- [ ] Uninstall, send again: the server marks the token inactive (`UNREGISTERED`).

**Not verifiable here and not expected to pass**: anything needing a release-signed build (App
Links verification against a real `assetlinks.json`, Play internal testing) — see below.

## What blocks a distributable build

All deliberately outside the Android Parity Epic's scope, all still outstanding:

- **Release keystore.** `build.gradle` has no `signingConfigs.release` and nothing in the repo
  references an upload key. Until it exists every build is debug-signed, `assetlinks.json`
  cannot name a shipped certificate, and Play will not accept an upload.
- **Play Console.** No app record, no internal-testing track, no store listing, no privacy
  declarations (the data-safety form needs the same answers `PrivacyInfo.xcprivacy` gives on iOS).
- **`assetlinks.json`** at `https://pagespace.ai/.well-known/assetlinks.json`, served by the
  marketing app like the AASA is, carrying the release certificate's SHA-256 — and only then the
  https intent filter above.
- **Release automation.** iOS has a fastlane `beta` lane; Android has nothing. A Gradle
  `bundleRelease` + Play upload lane (fastlane `supply`, or the Gradle Play Publisher plugin) is
  the equivalent.
- **Notification icon.** A monochrome `ic_notification` and the two Firebase meta-data entries in
  the manifest, or the tray shows Firebase's default glyph.
- **Dependency disclosure.** `@capgo/capacitor-social-login`'s Android `build.gradle` pulls the
  Facebook SDK by default, as its iOS target does — but unlike iOS it is **excludable**: the plugin
  reads the Gradle property `socialLogin.facebook.include` (default `'true'`), so
  `socialLogin.facebook.include=false` in `android/gradle.properties` drops it from the APK. We
  never initialise Facebook, so set that before the first listing rather than disclosing an SDK
  that does nothing. `OSS-COMPLIANCE.md` at the repo root carries the mobile native-dependency
  inventory (the per-platform files were folded into it in #1029); re-check it against
  `capacitor.settings.gradle` after a sync before any listing.
