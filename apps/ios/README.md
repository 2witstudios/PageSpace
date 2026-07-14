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

Push is driven from the web layer (`apps/web/src/hooks/usePushNotifications.ts`), device tokens
POST to `/api/notifications/push-tokens`, and the server sends via
`packages/lib/src/notifications/push-notifications.ts` (ES256 JWT over HTTP/2 to APNs). The app
icon badge is projected from the unread count (`useIosBadgeSync.ts` + `deriveBadgeCount`).

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

## Versioning

Bump both, in `ios/App/App.xcodeproj/project.pbxproj` (Debug + Release configs):

- `MARKETING_VERSION` — user-facing version (e.g. `1.3`)
- `CURRENT_PROJECT_VERSION` — build number, must strictly increase per upload (e.g. `4`)

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

### Manual fallback (Xcode GUI)

1. Open `ios/App/App.xcodeproj`, select **Any iOS Device (arm64)**.
2. **Product → Archive**.
3. In the Organizer: **Distribute App → App Store Connect → Upload**.
4. In App Store Connect: attach the build, complete metadata/privacy, add reviewer notes +
   demo account, **Submit for Review**.

## Submitting to the App Store — checklist

- [ ] Version + build number bumped and committed
- [ ] `cap sync` changes committed (pbxproj, Package.resolved)
- [ ] Build uploaded and finished **Processing** in App Store Connect
- [ ] App privacy answers match `ios/App/PrivacyInfo.xcprivacy`
      (Email + User ID linked / App Functionality; Device ID / Analytics, not linked; Tracking = No)
- [ ] Screenshots uploaded (6.7" iPhone required; iPad sizes if iPad is offered)
- [ ] Age rating, pricing, export compliance (standard HTTPS encryption → exempt) completed
- [ ] APNs Auth Key (`MWV7BG9H8Q`) registered in Apple Developer and linked to the app
- [ ] Reviewer notes emphasize native features + a working demo account is provided
- [ ] Submit for review

## Privacy manifest

`ios/App/PrivacyInfo.xcprivacy` (bundled — referenced by the `App` target's Copy Bundle Resources).
Keep the App Store Connect privacy answers in sync with this file. There should be exactly one
copy of this file in the repo.
