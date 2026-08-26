# PageSpace Android

Capacitor wrapper around the web app, mirroring `apps/ios`.

> **Scope of this file today:** only the server-side push requirements below, added with the FCM
> sender. Client-side setup — the runtime permission prompt, token registration, build and signing
> — belongs to the Android client work and is not documented here yet.

## Server-side push requirements (production `pagespace-web`)

FCM sending needs one secret set on the Fly web app:

- `FCM_SERVICE_ACCOUNT_JSON` — the whole service account JSON on a single line, from the Firebase
  console → Project settings → Service accounts → Generate new private key.

The Firebase project id is read out of that JSON, so there is no second variable to keep in sync
with it. The project the app is built against is `pagespace-f328e`
(`apps/android/android/app/google-services.json`) — a service account from any other project will
be rejected by FCM with `SENDER_ID_MISMATCH` on every send.

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
2. a silent one (a badge sync) — should **not** appear in the tray; it is sent data-only precisely
   so Android does not render it
3. one to a deliberately corrupted registration token — the row should be deactivated immediately
   rather than retried

Only a token-specific verdict from FCM deactivates a device. Credential, project, quota, outage
and malformed-message rejections never count against a phone, however many times they occur.
