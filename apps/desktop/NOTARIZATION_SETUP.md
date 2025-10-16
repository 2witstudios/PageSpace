# macOS Notarization Setup

The desktop app is now configured for macOS notarization. To complete the setup, you need to add three GitHub Secrets.

## Required GitHub Secrets

### 1. APPLE_ID
Your Apple ID email address (the one associated with your Apple Developer account).

**Example**: `j.minhw@icloud.com`

### 2. APPLE_APP_SPECIFIC_PASSWORD
An app-specific password generated for notarization.

**How to generate**:
1. Go to https://appleid.apple.com/account/manage
2. Sign in with your Apple ID
3. Navigate to "Sign-In and Security" → "App-Specific Passwords"
4. Click "+" to generate a new password
5. Enter a label like "PageSpace Notarization"
6. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

**Important**: Save this password immediately - you cannot view it again after closing the dialog.

### 3. APPLE_TEAM_ID
Your Apple Developer Team ID.

**Value**: `M96WTV3CKX` (already identified from your build logs)

## Adding Secrets to GitHub

1. Go to your GitHub repository: https://github.com/YOUR_USERNAME/PageSpace
2. Click "Settings" → "Secrets and variables" → "Actions"
3. Click "New repository secret" for each secret:
   - Name: `APPLE_ID`, Value: Your Apple ID email
   - Name: `APPLE_APP_SPECIFIC_PASSWORD`, Value: Your app-specific password
   - Name: `APPLE_TEAM_ID`, Value: `M96WTV3CKX`

## Testing Notarization

After adding the secrets:

1. Create and push a new tag:
   ```bash
   git tag desktop-v1.0.4
   git push origin desktop-v1.0.4
   ```

2. Monitor the GitHub Actions workflow at:
   https://github.com/YOUR_USERNAME/PageSpace/actions

3. Look for the "Package macOS app (signed and notarized)" step

4. Successful notarization will show:
   ```
   • signing file=dist-electron/mac-universal/PageSpace.app
   • notarizing app
   • notarization succeeded
   • stapling notarization ticket
   ```

5. Download the artifact and verify it opens without quarantine issues

## What Changed

### Files Created
- `apps/desktop/build/entitlements.mac.plist` - Main app entitlements for hardened runtime
- `apps/desktop/build/entitlements.mac.inherit.plist` - Inherited entitlements for child processes

### Files Modified
- `apps/desktop/package.json` - Added notarization configuration:
  - `hardenedRuntime: true`
  - `gatekeeperAssess: false`
  - Entitlements file paths
  - `notarize: true` to enable notarization (team ID comes from environment variable)

- `.github/workflows/build-desktop.yml` - Added environment variables:
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`

## Troubleshooting

### "configuration.mac.notarize should be a boolean" error
- This error occurs if `notarize` is configured as an object instead of a boolean
- The fix: Change `"notarize": { "teamId": "..." }` to `"notarize": true`
- The team ID should come from the `APPLE_TEAM_ID` environment variable, not the package.json

### "invalid credentials" or "HTTP status code: 401" error
This is the most common issue. Here's how to fix it:

1. **Verify Apple ID email** in GitHub Secrets:
   - Go to Settings → Secrets and variables → Actions
   - Edit the `APPLE_ID` secret
   - Make sure it matches EXACTLY the email for your Apple Developer account
   - No extra spaces before or after

2. **Regenerate app-specific password**:
   - Go to https://appleid.apple.com/account/manage
   - Navigate to "Sign-In and Security" → "App-Specific Passwords"
   - Delete the old PageSpace password
   - Generate a NEW one (e.g., `xxxx-xxxx-xxxx-xxxx`)
   - **Critical**: Copy it WITHOUT the dashes: `xxxxxxxxxxxxxxxx`
   - Update the `APPLE_APP_SPECIFIC_PASSWORD` secret in GitHub with the new password
   - **Common mistake**: Don't use your regular Apple ID password - must be app-specific!

3. **Check the debug output** in GitHub Actions logs:
   - Look for the "Debug notarization credentials" step
   - Verify all three show as "✓ is set"
   - If any show "ERROR", that secret isn't configured correctly
   - Check the app-specific password length - should be 16 characters (without dashes)

4. **Verify Team ID**:
   - Make sure `APPLE_TEAM_ID` is set to `M96WTV3CKX`
   - Check the debug output shows this exact value

### "Could not find team" error
- Verify `APPLE_TEAM_ID` is set to `M96WTV3CKX`
- Check that your Apple Developer account is active

### Notarization timeout
- Notarization typically takes 2-5 minutes
- Apple's servers may be slow during peak hours
- The workflow will retry automatically if it times out

### App still won't open after download
- Verify the build logs show "notarization succeeded"
- Check that the notarization ticket was stapled
- Try downloading a fresh copy (don't use cached downloads)
