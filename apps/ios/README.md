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
> and app-icon badge sync — is what clears this bar. Always submit with reviewer notes calling
> these out plus a working demo account (see "Submitting", below).
>
> Universal links are **not** on that list: the entitlement is declared but the AASA claims no
> paths, because nothing routes an incoming link yet. See below.

## Native capabilities (entitlements)

`ios/App/App/App.entitlements`:

- `aps-environment = production` — push notifications (production APNs)
- Associated domains: `applinks:pagespace.ai`, `webcredentials:pagespace.ai`
- Sign in with Apple

### Universal links (associated domains) — claimed paths deferred

The entitlement declares `applinks:pagespace.ai`, but the served AASA claims **no paths**, on
purpose. Claiming a path without routing it is worse than not claiming it: the link stops opening
in Safari, where it works, and instead launches the app at `server.url` (`/dashboard`) — silently
dropping the invite token. `apps/android/README.md` ("Prerequisite 2") documents the same trap,
which is why Android has not claimed App Links either.

**The prerequisite:** nothing consumes the `@capacitor/app` plugin's `appUrlOpen` event or
`getLaunchUrl()` on either platform. Both are needed — `getLaunchUrl` for a cold start, `appUrlOpen`
for a warm one — before any path goes into `paths`.

What the file does carry is `webcredentials`, which needs no routing: it enables associated-domain
password autofill for `pagespace.ai`.

Mechanics, for whoever picks this up: Caddy routes `/.well-known/*` to **marketing** (only
`oauth-*` reaches web), so the single source of truth is
`apps/marketing/public/.well-known/apple-app-site-association`. `appID` is team plus bundle id —
`M96WTV3CKX.ai.pagespace.ios` — and it must be served as `application/json` (the file is
deliberately extensionless, so `apps/marketing/next.config.ts` sets the header). Apple's CDN caches
it, so after any change: redeploy marketing, curl the live URL, then reinstall the app before
testing on device.

When paths are eventually claimed, do **not** add the OAuth callbacks: native sign-in returns
through the `pagespace://auth-exchange` custom scheme, and claiming those paths would hijack the
web fallback.

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
      returns `M96WTV3CKX.ai.pagespace.ios` as `application/json` with **no** claimed `applinks`
      paths (see "Universal links", above)
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
      keychain session persistence, app-icon badge — and **not** universal links, plus a working
      demo account with seeded content
- [ ] Submit for review

## Privacy manifest

`ios/App/PrivacyInfo.xcprivacy` (bundled — referenced by the `App` target's Copy Bundle Resources).
Keep the App Store Connect privacy answers in sync with this file. There should be exactly one
copy of this file in the repo.
