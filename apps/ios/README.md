# PageSpace iOS App

Capacitor 7 wrapper around the PageSpace web app, distributed via TestFlight and the App Store.

- **Bundle ID:** `ai.pagespace.ios`
- **Apple Team:** `M96WTV3CKX`
- **Signing:** Automatic (managed by Xcode / fastlane match-free automatic signing)
- **Dependency manager:** Swift Package Manager (SPM) — **no CocoaPods, no Podfile**
- **Xcode project:** `ios/App/App.xcodeproj` (target `App`) — there is **no** `.xcworkspace`

## Architecture

This is a **remote-loading** app. The WebView loads the live site directly:

- `server.url = https://pagespace.ai/dashboard` (see `capacitor.config.ts`)
- `webDir: ./public` is only an offline fallback shell (`errorPath: index.html`)
- Because behavior comes from the live site, most product changes ship without an app update.
  You only need a new build when native config changes: version bump, entitlements, plugins,
  Info.plist, icons/splash, or a Capacitor/plugin upgrade.

> **App Review note (Guideline 4.2):** Apple scrutinizes thin WebView wrappers. Our native
> value — push notifications, Sign in with Apple, native social login, the keychain plugin,
> app-icon badge sync, and universal links — is what clears this bar. Always submit with
> reviewer notes calling these out plus a working demo account (see "Submitting", below).

## Native capabilities (entitlements)

`ios/App/App/App.entitlements`:

- `aps-environment = production` — push notifications (production APNs)
- Associated domains: `applinks:pagespace.ai`, `webcredentials:pagespace.ai`
- Sign in with Apple

### Universal links (associated domains)

`https://pagespace.ai/invite/*` and `https://pagespace.ai/auth/magic-link/*` open in the app.
Three pieces have to agree, and they broke independently before:

1. **Entitlement** — `applinks:pagespace.ai` in `App.entitlements`.
2. **The AASA** — Caddy routes `/.well-known/*` to **marketing** (only `oauth-*` reaches web), so
   the single source of truth is `apps/marketing/public/.well-known/apple-app-site-association`.
   `appID` is team plus bundle id (`M96WTV3CKX.ai.pagespace.ios`), and it must be served as
   `application/json` — the file is deliberately extensionless, so `apps/marketing/next.config.ts`
   sets the header.
3. **Routing** — `apps/web/src/components/DeepLinkHandler.tsx`, mounted in the **root**
   `apps/web/src/app/layout.tsx`, not the dashboard layout: a signed-out `/dashboard` is rewritten
   to `/auth/signin`, and both an invite tap and a magic-link tap are very often signed out, so
   mounted any lower the launch URL is never read. Both halves are required: `App.getLaunchUrl()` for a cold start (the
   URL is spent before any listener exists) and the `appUrlOpen` listener for a warm one (the
   native side only notifies plugins, it never calls `loadUrl`, so without a listener the WebView
   simply stays put). Which URLs resolve to which route is
   `apps/web/src/lib/navigation/deep-links.ts`.

**Keep `paths` and the resolver in step.** Claiming a path the resolver returns `null` for stops
the link working in Safari and does nothing in the app — strictly worse than never claiming it. The
resolver hands any unrecognised URL on the claimed host to the browser rather than swallowing it,
which limits the blast radius but is not a licence to claim loosely.

Navigation goes through the router, never `window.location`: in the iOS shell a top-level location
change reaches Capacitor's `WKNavigationDelegate`, which cancels anything outside `server.url`'s
`/dashboard` prefix and opens system Safari, blanking the WebView. `/invite/*` and
`/auth/magic-link/*` are both outside that prefix.

### Magic links, and why they are a universal link

A magic link requested from the app used to be unusable. `apps/web/src/lib/desktop-auth.ts` knew
only about Electron, so the token was minted with no platform metadata and the email carried the
plain `/api/auth/magic-link/verify?token=…` URL. iOS does not claim that path, so the tap opened
Safari, the session cookie landed in **Safari's** cookie jar, and the WebView — which
authenticates with a bearer token read from the Keychain (`platform-storage/ios-storage.ts`,
`usesBearer() === true`) — stayed signed out. There was no path by which it could succeed.

Now `apps/web/src/lib/auth/magic-link-platform-fields.ts` reports the shell and this device's id
(the same id native Google / Apple sign-in use), the send route binds the link to it, and the
adapter mints `https://pagespace.ai/auth/magic-link/<token>` instead — a claimed path, so the tap
opens the app. `apps/web/src/app/auth/magic-link/[token]/page.tsx` then redeems the token with a
same-origin `POST /api/auth/magic-link/verify`: the response's `Set-Cookie` lands in the WebView's
own jar, and because the page presents the bound `deviceId`, the route also returns
`sessionToken` / `csrfToken` / `deviceToken`, which the page writes to the Keychain — the same
shape and the same store as `/api/auth/{apple,google}/native`.

Bearer tokens are released **only** to the device the link was bound to. The same link opened
anywhere else (a laptop browser, a second phone) still signs that browser in by cookie and
receives no tokens, so a forwarded email cannot hand anyone a native session. The emailed URL for
a link requested from a browser is unchanged, and that path stays unclaimed — a link requested in
Safari must complete in Safari.

Do **not** claim the OAuth callback paths. Native sign-in returns through the
`pagespace://auth-exchange` custom scheme, and `/api/auth/desktop/exchange` redeems its code with
no PKCE binding — whichever app receives the code can take a session. The resolver ignores that
scheme outright, and binding the exchange is a prerequisite for ever changing that.

Apple's CDN caches the AASA, so after any change: redeploy marketing, curl the live URL, then
reinstall the app before testing on device.

Push is driven from the web layer (`apps/web/src/hooks/usePushNotifications.ts`), device tokens
POST to `/api/notifications/push-tokens`, and the server sends via
`packages/lib/src/notifications/push-notifications.ts` (ES256 JWT over HTTP/2 to APNs). The app
icon badge is projected from the unread count (`useNativeBadgeSync.ts` + `deriveBadgeCount`).

### Server-side push requirements (production `pagespace-web`)

APNs sending needs these secrets set on the Fly web app (values live in the repo `.env`):

- `APNS_TEAM_ID` (`M96WTV3CKX`)
- `APNS_KEY_ID` (`MWV7BG9H8Q`)
- `APNS_PRIVATE_KEY` (`.p8` PEM contents)
- `APNS_BUNDLE_ID` (optional; defaults to `ai.pagespace.ios`)

The server picks the APNs host by `NODE_ENV` (`production` → `api.push.apple.com`, else sandbox).
Because the app entitlement is `production`, the production server **must** run with
`NODE_ENV=production` or production-token pushes will be rejected by the sandbox host.

### Sign in with Apple token revocation (production `pagespace-web`)

App Store Guideline 5.1.1(v) and Apple TN3194 require revoking a user's Sign in with Apple tokens
when they delete their account. Sign-in exchanges Apple's authorization code for a refresh token
(stored encrypted in `apple_sign_in_tokens`), account deletion revokes it via `/auth/revoke`, and
Apple's server-to-server notifications end sessions when a user stops using Sign in with Apple.
Everything is skipped until the key below is configured; deletion then shows the manual steps.

1. developer.apple.com → Certificates, Identifiers & Profiles → **Keys** → + → name it
   "PageSpace Sign in with Apple" → tick **Sign in with Apple** → Configure → Primary App ID
   **ai.pagespace.ios** → Save → Continue → Register → **Download `AuthKey_<KEYID>.p8`** (it can only be
   downloaded once — store it in the password manager) and note the **Key ID**.
2. Identifiers → **ai.pagespace.ios** → Sign in with Apple → Edit → **Server-to-Server Notification
   Endpoint** = `https://pagespace.ai/api/auth/apple/notifications` → Save.
3. Set the secrets on the Fly web app (`APPLE_TEAM_ID=M96WTV3CKX` is already set):
   `flyctl secrets set -a pagespace-web APPLE_SIGN_IN_KEY_ID=<KEYID> APPLE_SIGN_IN_PRIVATE_KEY="$(cat AuthKey_<KEYID>.p8)"`.
   Optionally set the same two plus `APPLE_TEAM_ID`, `APPLE_CLIENT_ID`, `APPLE_SERVICE_ID` on
   `pagespace-admin` so the admin app's DSAR delete revokes too. Add the names to PageSpace-Deploy
   `fly/SECRETS.md`.
4. After deploy: `curl -s -o /dev/null -w '%{http_code}' -X POST https://pagespace.ai/api/auth/apple/notifications -d '{}'`
   returns `400` (not `404`).

## Building locally

Prereqs: Xcode + CLI tools, `bun` at the repo root.

```bash
# From the repo root — build the web app, then sync native
bun run --cwd apps/ios build:full     # builds `web` workspace, then `cap sync ios`
# or, if the web build is current:
bun run --cwd apps/ios build          # `cap sync ios` only

# Open in Xcode
bun run --cwd apps/ios dev            # `cap open ios`
```

`cap sync` regenerates `ios/App/App/capacitor.config.json` and the SPM
`CapApp-SPM/Package.swift` plugin list. After a Capacitor or plugin upgrade, **commit** the
resulting changes to `project.pbxproj` and `Package.resolved` so CI/TestFlight builds match source.

> **Run `cap sync` immediately before every archive.** `capacitor.config.json` is gitignored, so a
> stale copy on disk is invisible to review and ships whatever it last held — a theme change once
> shipped the previous `#0B0B0B` for several builds. Confirm the synced colours match
> `capacitor.config.ts` before you archive.

## Versioning

Bump both, in `ios/App/App.xcodeproj/project.pbxproj` (Debug + Release configs):

- `MARKETING_VERSION` — user-facing version (currently `1.4`)
- `CURRENT_PROJECT_VERSION` — build number, must strictly increase per upload (currently `5`)

`Info.plist` reads these via `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`.

## Releasing with fastlane

Fastlane drives archive → upload → submit headlessly using an **App Store Connect API key**
(so no interactive Apple login / 2FA). Configure the key once via environment or `fastlane/Appfile`:

- `ASC_KEY_ID`, `ASC_ISSUER_ID`, and the `.p8` key file (path in `APP_STORE_CONNECT_API_KEY_PATH`).

Lanes (`fastlane/Fastfile`):

```bash
cd apps/ios
bundle exec fastlane beta      # gym (archive, ExportOptions.plist) → pilot (upload to TestFlight)
bundle exec fastlane release   # deliver: push metadata + submit the App Store version for review
```

`ExportOptions.plist` pins `method = app-store`, the team, and automatic signing.

> **Do not run `fastlane release` yet.** That lane calls `deliver` with `force: true`, and there is
> no `fastlane/metadata/` directory in the repo — it would overwrite the App Store listing with
> empty metadata. `beta` is safe. Use App Store Connect directly for metadata until a committed
> `metadata/` exists.

### Manual fallback (Xcode GUI)

1. Open `ios/App/App.xcodeproj`, select **Any iOS Device (arm64)**.
2. **Product → Archive**.
3. In the Organizer: **Distribute App → App Store Connect → Upload**.
4. In App Store Connect: attach the build, complete metadata/privacy, add reviewer notes +
   demo account, **Submit for Review**.

## Submitting to the App Store — checklist

- [ ] Version + build number bumped and committed
- [ ] `cap sync` run immediately before archiving; `capacitor.config.json` matches `capacitor.config.ts`
- [ ] Archive signed with an **Apple Distribution** identity (check Xcode Organizer before uploading)
- [ ] AASA verified live: `curl https://pagespace.ai/.well-known/apple-app-site-association`
      returns `M96WTV3CKX.ai.pagespace.ios` as `application/json`, **and** an
      `https://pagespace.ai/invite/...` link opens the app on a device from both a cold start and
      with the app already running (the two paths are handled separately — verify both)
- [ ] Magic link verified on a device: request one **from the app**, tap it in Mail, and confirm
      the app opens signed in (not Safari). Then request a **second** link from the app and open
      that one on a Mac — the first is spent, so reusing it only proves `magic_link_used` — and
      confirm the browser is signed in by cookie with no tokens handed out
- [ ] Build uploaded and finished **Processing** in App Store Connect
- [ ] App privacy answers match `ios/App/PrivacyInfo.xcprivacy` exactly — every type there is
      **linked**, none is used for tracking (Tracking = No): Name, Email, User ID (App
      Functionality + Developer's Advertising or Marketing — product-update emails); Photos or
      Videos, Audio Data (voice calls), Customer Support, Other User Content, Device ID (App
      Functionality); Product Interaction, Other Usage Data, Crash Data, Performance Data (App
      Functionality + Analytics). The native app sends no analytics and records no Sentry Session
      Replay (both refused inside Capacitor), but keep them declared — the labels cover the service
- [ ] Screenshots uploaded for 6.9" iPhone **and** 13" iPad (`TARGETED_DEVICE_FAMILY = "1,2"`
      claims iPad, so iPad shots are required). Generated from real simulator captures — see
      `apps/marketing/public/screenshots/ios/README.md`
- [ ] Support URL is `https://pagespace.ai/contact` — `/support` is not publicly reachable
- [ ] Age rating, pricing, export compliance completed (`ITSAppUsesNonExemptEncryption = false`
      ships in the plist, so no per-upload prompt)
- [ ] APNs Auth Key (`MWV7BG9H8Q`) registered in Apple Developer and linked to the app, and
      production `pagespace-web` runs `NODE_ENV=production` (otherwise every push is rejected)
- [ ] No purchase surface reachable on iOS — walk `/settings/billing`, `/settings/usage`, and any
      in-app link that reaches marketing pricing (Guideline 3.1.1)
- [ ] Reviewer notes emphasize native features — push, Sign in with Apple, native Google sign-in,
      keychain session persistence, app-icon badge, universal links — plus a working demo account
      with seeded content
- [ ] Sign in with Apple revocation live (Guideline 5.1.1(v)): key + notification endpoint set up as
      in "Sign in with Apple token revocation" above; sign in with Apple on a test Apple Account in
      the app, delete the account from Settings → Account, and confirm PageSpace is gone from
      Settings → your name → Sign-In & Security → Sign in with Apple, and that signing in again asks
      for name and email
- [ ] Submit for review

## The Facebook SDK that ships but never runs

`Package.resolved` pins `facebook-ios-sdk 18.x`. Nothing here configures Facebook login — it
arrives because `@capgo/capacitor-social-login` hard-depends on `FacebookCore` and `FacebookLogin`
in its own plugin target, so it cannot be excluded without forking the plugin.

It is linked but inert, and each link in that chain was checked:

- `Info.plist` declares no `FacebookAppID` and no `FacebookClientToken`. The SDK cannot initialize
  or send anything without them.
- `FacebookProvider.init()` only configures an `ISO8601DateFormatter`; its `initialize()` is an
  empty method.
- The plugin only reaches Facebook when `SocialLogin.initialize` is called with a `facebook` object
  carrying an `appId`. We call it with `apple` (`native-apple-auth.ts`) and `google`
  (`native-google-auth.ts`) only.

So `NSPrivacyTracking = false` is accurate. Facebook ships the SDK signature and privacy manifest
Apple requires of it, so the binary is compliant as-is.

**If Facebook login is ever added**, revisit this: the SDK auto-logs app events and collects the
advertiser ID once an app ID exists, which changes both the tracking declaration and the App Store
Connect nutrition labels. `FacebookAutoLogAppEventsEnabled` and
`FacebookAdvertiserIDCollectionEnabled` (both `false`) are the plist keys that turn that off. They
are deliberately absent today — with no app ID there is nothing to disable, and dead configuration
rots.

## Privacy manifest

`ios/App/PrivacyInfo.xcprivacy` (bundled — referenced by the `App` target's Copy Bundle Resources).
Keep the App Store Connect privacy answers in sync with this file. There should be exactly one
copy of this file in the repo.
