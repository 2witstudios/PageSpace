# PageSpace Android

Capacitor wrapper around the web app, mirroring `apps/ios`.

> **Scope of this file today:** the server-side push requirements below (added with the FCM
> sender) and the deep-link deployment dependency. Client-side setup — the runtime permission
> prompt, token registration, build and signing — belongs to the Android client work and is not
> documented here yet.

## Deep links need an assetlinks.json that does not exist yet

`AndroidManifest.xml` registers two deep-link intent filters:

- **Verified App Links** for `https://pagespace.ai`, on the same paths iOS claims in
  `apps/web/public/.well-known/apple-app-site-association` (`/auth/callback/*`,
  `/api/auth/callback/*`, `/invite/*`, `/join/*`).
- **The `pagespace://` custom scheme**, mirroring iOS's `CFBundleURLSchemes`. This is what the
  Google and Apple OAuth callback routes redirect to (`pagespace://auth-exchange?code=…`).

The custom scheme works as soon as the app is installed. **The App Links do not, and will not
until `/.well-known/assetlinks.json` is served from `pagespace.ai`** carrying the SHA-256
fingerprint of the *release* signing certificate:

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

That fingerprint does not exist: a release keystore and Play Console setup are deliberately
outside the Android parity epic. Until it does, Android's link verification fails and — because
the filter is `android:autoVerify="true"` and the app targets SDK 36 — the app is simply not
offered as a handler and the link opens in the browser. That is the intended degradation; it is
also why the filter must keep `autoVerify`, since without it PageSpace would appear in the
disambiguation chooser on every `pagespace.ai` link.

To verify locally before then, serve the same file with the **debug** keystore's fingerprint
(`keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android`)
and re-run verification with `adb shell pm verify-app-links --re-verify ai.pagespace.android`,
then inspect `adb shell pm get-app-links ai.pagespace.android`.

One further gap, shared with iOS: nothing in the web app listens for the Capacitor App plugin's
`appUrlOpen` event, so a captured link opens the app at `server.url` (`/dashboard`) rather than at
the linked path. Widening the host capture beyond the paths above should wait on that routing.

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
