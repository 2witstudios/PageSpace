# PageSpace Mobile

Native mobile app wrapper for PageSpace using Capacitor.

## Quick Start

```bash
# Install dependencies
pnpm install

# Add native platforms
npx cap add ios
npx cap add android

# Sync web assets and native plugins
pnpm sync

# Open in Xcode (iOS)
pnpm open:ios

# Open in Android Studio (Android)
pnpm open:android
```

## Development

The app loads the remote PageSpace server by default. To test against local development:

1. Edit `capacitor.config.ts`:
   ```typescript
   server: {
     url: 'http://localhost:3000',
     cleartext: true, // Allow HTTP for local dev
   }
   ```

2. Run `pnpm sync` to update native projects

3. Run in simulator/emulator

## Architecture

This app uses the same pattern as the Electron desktop app:

- **Remote WebView**: Loads `https://pagespace.ai` in a native WebView
- **Bridge API**: Exposes `window.mobile` with auth and native APIs
- **Secure Storage**: Uses iOS Keychain / Android Keystore for tokens

### API Parity with Electron

| Electron (`window.electron`) | Mobile (`window.mobile`) |
|------------------------------|--------------------------|
| `auth.getJWT()` | `auth.getJWT()` |
| `auth.getSession()` | `auth.getSession()` |
| `auth.storeSession()` | `auth.storeSession()` |
| `auth.clearAuth()` | `auth.clearAuth()` |
| `auth.getDeviceInfo()` | `auth.getDeviceInfo()` |
| `onDeepLink()` | `onDeepLink()` |
| `isDesktop: true` | `isMobile: true` |

## Building for Release

### iOS

1. Open Xcode: `pnpm open:ios`
2. Select your team in Signing & Capabilities
3. Archive and upload to App Store Connect

### Android

1. Open Android Studio: `pnpm open:android`
2. Build > Generate Signed Bundle / APK
3. Upload to Google Play Console

## Deep Links

The app handles `pagespace://` URLs:

- `pagespace://dashboard` - Open dashboard
- `pagespace://page/[id]` - Open specific page
- `pagespace://drive/[id]` - Open specific drive
