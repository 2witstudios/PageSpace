# GitHub Actions Setup for Desktop App Builds

This document explains how to configure GitHub Actions to automatically build PageSpace desktop app packages for macOS, Windows, and Linux.

## Workflow Overview

The workflow in `.github/workflows/build-desktop.yml` builds the desktop app on three platforms:

- **macOS**: `.dmg` and `.zip` (Universal binary for Intel + Apple Silicon)
- **Windows**: `.exe` installer (NSIS) and portable `.exe`
- **Linux**: `.AppImage`, `.deb`, and `.rpm`

## How to Trigger Builds

### Option 1: Git Tag (Recommended)
Push a git tag starting with `desktop-v`:

```bash
git tag desktop-v1.0.0
git push origin desktop-v1.0.0
```

This will automatically:
1. Build packages for all three platforms
2. Create a draft GitHub Release
3. Upload all packages to the release

### Option 2: Manual Trigger
Go to GitHub Actions tab → "Build Desktop App" → "Run workflow"

## Required GitHub Secrets

Configure these in your GitHub repository settings (Settings → Secrets and variables → Actions):

### macOS Code Signing (Optional but Recommended)

**`MACOS_CERTIFICATE`** (base64-encoded .p12 file):
```bash
# Export your certificate from Keychain Access as a .p12 file
# Then encode it to base64:
base64 -i YourCertificate.p12 | pbcopy
# Paste the result into GitHub Secrets
```

**`MACOS_CERTIFICATE_PWD`** (password for the .p12 file):
```
The password you set when exporting the certificate
```

### Windows Code Signing (Optional)

**`WINDOWS_CERTIFICATE`** (base64-encoded certificate):
```bash
# If you have a Windows code signing certificate:
base64 -i YourWindowsCert.pfx | pbcopy
```

**`WINDOWS_CERTIFICATE_PWD`** (certificate password):
```
Password for your Windows code signing certificate
```

> **Note**: The workflow will still build without code signing certificates, but the apps won't be signed.

## How to Set Up macOS Code Signing Certificate

### 1. Export Certificate from Keychain Access
1. Open **Keychain Access** on your Mac
2. Find your "Apple Development" or "Developer ID Application" certificate
3. Right-click → **Export "Certificate Name"**
4. Choose **.p12** format
5. Set a password (you'll need this for GitHub Secrets)
6. Save the file

### 2. Convert to Base64
```bash
base64 -i YourCertificate.p12 | pbcopy
```

### 3. Add to GitHub Secrets
1. Go to your GitHub repository
2. Navigate to **Settings → Secrets and variables → Actions**
3. Click **New repository secret**
4. Name: `MACOS_CERTIFICATE`
5. Value: Paste the base64 string
6. Click **Add secret**

### 4. Add Certificate Password
1. Click **New repository secret** again
2. Name: `MACOS_CERTIFICATE_PWD`
3. Value: The password you set when exporting
4. Click **Add secret**

## Testing the Workflow

1. **Test without code signing first**:
   ```bash
   git tag desktop-v1.0.0-test
   git push origin desktop-v1.0.0-test
   ```

2. **Check the Actions tab** in GitHub to see build progress

3. **Download artifacts** from the completed workflow run

4. **Test on each platform**:
   - macOS: Install from the .dmg or .zip
   - Windows: Run the .exe installer or portable
   - Linux: Run the .AppImage or install the .deb/.rpm

## Build Output

After the workflow completes, you'll find:

- **Artifacts tab**: Download packages for testing
- **Releases tab**: Draft release with all packages attached (if triggered by tag)

## Troubleshooting

### Build fails on macOS with certificate error
- Verify `MACOS_CERTIFICATE` is correctly base64 encoded
- Verify `MACOS_CERTIFICATE_PWD` is correct
- Make sure the certificate is not expired or revoked

### Build fails on Windows
- Windows builds don't require code signing to succeed
- If you added `WINDOWS_CERTIFICATE`, verify it's correctly encoded

### Build fails on Linux
- Linux builds rarely fail - check the error logs in GitHub Actions

## Production Checklist

Before distributing to users:

- [ ] Test all three platform packages
- [ ] Verify code signing works (no security warnings)
- [ ] Test the app connects to pagespace.ai/dashboard
- [ ] Verify all buttons and UI elements work
- [ ] Test window dragging and traffic light positioning
- [ ] Update version number in `apps/desktop/package.json`
- [ ] Create release notes

## Release Process

1. **Update version**:
   ```bash
   cd apps/desktop
   # Update version in package.json to 1.0.1, etc.
   ```

2. **Commit and push**:
   ```bash
   git add apps/desktop/package.json
   git commit -m "Bump desktop version to 1.0.1"
   git push
   ```

3. **Create and push tag**:
   ```bash
   git tag desktop-v1.0.1
   git push origin desktop-v1.0.1
   ```

4. **Wait for GitHub Actions** to complete

5. **Go to Releases** → Edit the draft release → Publish

## Local Building (Alternative)

If you prefer to build locally instead of using GitHub Actions:

```bash
# macOS (on Mac)
pnpm --filter desktop package:mac

# Windows (on Windows PC or VM)
pnpm --filter desktop package:win

# Linux (on Linux)
pnpm --filter desktop package:linux
```

Packages will be in `apps/desktop/dist-electron/`
