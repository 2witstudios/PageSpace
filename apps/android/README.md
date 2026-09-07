# PageSpace Android

Capacitor wrapper around the web app, mirroring `apps/ios`.

> **Scope of this file today:** the server-side push requirements below (added with the FCM
> sender) and the deep-link deployment dependency. Client-side setup — the runtime permission
> prompt, token registration, build and signing — belongs to the Android client work and is not
> documented here yet.

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
so link verification cannot succeed on any Android version today.

### Prerequisite 2 — link routing in the web app

Nothing listens for the `@capacitor/app` plugin's `appUrlOpen` event, on **either** platform. A
captured link therefore opens the app at `server.url` (`/dashboard`), not at the linked path: the
invite token or auth callback code in the URL is silently dropped.

### Why `autoVerify` alone is not enough here

`android:autoVerify="true"` is often described as making an unverified filter degrade safely to
the browser. That is true only on **API 31+**, and it is a behaviour of the *device's* platform
version, not of `targetSdk`:

| Device API level | Filter present, verification fails |
|---|---|
| 31+ (Android 12+) | App is not a candidate; link opens in the browser. Safe. |
| 23–30 (Android 6–11) | Filter stays eligible; PageSpace appears in the disambiguation chooser. |

`minSdkVersion` is 23, so the second row is in scope. On those devices a user who picks PageSpace
from the chooser lands on `/dashboard` with the token gone — strictly worse than the browser,
for no gain, since verification cannot succeed anyway. Hence: deferred, not shipped.

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
