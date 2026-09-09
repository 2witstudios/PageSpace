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
      the app opens signed in (not Safari). Then open the same link on a Mac and confirm it signs
      that browser in without handing out tokens
- [ ] Build uploaded and finished **Processing** in App Store Connect
- [ ] App privacy answers match `ios/App/PrivacyInfo.xcprivacy` (Email + User ID linked / App
      Functionality; Device ID / Analytics and Crash + Performance Data, not linked; Product
      Interaction linked / Analytics for Sentry Session Replay; Tracking = No)
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
