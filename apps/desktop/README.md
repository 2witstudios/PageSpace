# PageSpace Desktop

Native desktop application for PageSpace. This is an Electron wrapper that connects to your PageSpace cloud instance.

## Architecture

The desktop app is a lightweight Electron wrapper that loads your PageSpace web application from your cloud VPS. It provides native desktop integration including:

- **System Tray Integration**: Minimize to tray, quick access
- **Native Menus**: macOS/Windows/Linux native application menus
- **Auto-Updates**: Automatic application updates
- **Deep Linking**: Support for `pagespace://` URLs
- **Window State Persistence**: Remembers window size and position

## Development

### Prerequisites

- Node.js 20+
- pnpm

### Running Locally

```bash
# From the root of the monorepo
pnpm --filter desktop dev
```

This will launch the Electron app pointing to `http://localhost:3000` (make sure the web app is running).

### Building

```bash
# Build TypeScript
pnpm --filter desktop build

# Create distributable packages
pnpm --filter desktop package        # Build for current platform
pnpm --filter desktop package:mac    # Build for macOS
pnpm --filter desktop package:win    # Build for Windows
pnpm --filter desktop package:linux  # Build for Linux
```

## Configuration

### Environment Variables

Create a `.env` file in `apps/desktop/`:

```bash
# URL of your PageSpace instance
PAGESPACE_URL=https://your-vps-url.com

# Environment (development/production)
NODE_ENV=production
```

### User Preferences

The app stores user preferences in the system's application data directory:

- **macOS**: `~/Library/Application Support/desktop/config.json`
- **Windows**: `%APPDATA%/desktop/config.json`
- **Linux**: `~/.config/desktop/config.json`

Preferences include:
- Window size and position
- Custom app URL override
- Minimize to tray setting

## Packaging & Distribution

### Code Signing

For production releases, you'll need to configure code signing:

**macOS:**
1. Get an Apple Developer certificate
2. Set environment variables:
   ```bash
   export CSC_LINK=/path/to/certificate.p12
   export CSC_KEY_PASSWORD=your_password
   ```

**Windows:**
1. Get a code signing certificate
2. Set environment variables:
   ```bash
   export CSC_LINK=/path/to/certificate.pfx
   export CSC_KEY_PASSWORD=your_password
   ```

### Auto-Updates

The app uses `electron-updater` for automatic updates. Configure your update server in `package.json`:

```json
{
  "build": {
    "publish": {
      "provider": "github",
      "owner": "your-username",
      "repo": "pagespace"
    }
  }
}
```

Or use a custom update server:

```json
{
  "build": {
    "publish": {
      "provider": "generic",
      "url": "https://your-update-server.com/downloads"
    }
  }
}
```

## Platform-Specific Notes

### macOS

- Universal binary includes both Intel and Apple Silicon
- Outputs: DMG installer and ZIP archive
- Supports Touch Bar if available
- HiDPI/Retina display ready

### Windows

- NSIS installer with installation wizard
- Portable executable (no installation required)
- Desktop shortcut creation
- Start menu integration

### Linux

- AppImage (universal, no installation)
- DEB package (Debian/Ubuntu)
- RPM package (Fedora/RHEL)

## Assets

Place your application icons in `apps/desktop/assets/`:

- `icon.icns` - macOS icon (512x512 or larger)
- `icon.ico` - Windows icon (256x256 or larger)
- `icon.png` - Linux icon (512x512 PNG)
- `tray-icon.png` - System tray icon (16x16 or 32x32)

You can use tools like:
- [electron-icon-builder](https://www.npmjs.com/package/electron-icon-builder)
- [png2icons](https://www.npmjs.com/package/png2icons)

## Troubleshooting

### App Won't Start

1. Check that the configured URL is accessible
2. Check the console logs: `View > Toggle Developer Tools`
3. Verify environment variables are set correctly

### Can't Connect to Cloud Instance

1. Verify `PAGESPACE_URL` is correct
2. Check firewall/network settings
3. Ensure CORS is configured on your VPS

### Build Errors

1. Ensure all dependencies are installed: `pnpm install`
2. Clear the build cache: `rm -rf dist dist-electron`
3. Rebuild: `pnpm build && pnpm package`

## License

CC-BY-NC-SA-4.0 - Same as PageSpace
