# PageSpace Desktop v1.0.29

**First Official Desktop Release** - Native desktop application for PageSpace

## Download

- **macOS**: [PageSpace.dmg](https://github.com/2witstudios/PageSpace/releases/download/desktop-v1.1.0/PageSpace.dmg) (Universal - Intel & Apple Silicon)
- **Windows**: [PageSpace.exe](https://github.com/2witstudios/PageSpace/releases/download/desktop-v1.1.0/PageSpace.exe) (x64)
- **Linux**:
  - [PageSpace.AppImage](https://github.com/2witstudios/PageSpace/releases/download/desktop-v1.1.0/PageSpace.AppImage)
  - [PageSpace.deb](https://github.com/2witstudios/PageSpace/releases/download/desktop-v1.1.0/PageSpace.deb)
  - [PageSpace.rpm](https://github.com/2witstudios/PageSpace/releases/download/desktop-v1.1.0/PageSpace.rpm)

## What's New

### Native Desktop Experience
- **System Integration**: Native desktop app with system tray support
- **Minimize to Tray**: Keep PageSpace running in the background
- **Deep Linking**: Support for `pagespace://` URLs
- **Window State**: Remembers your window size and position

### Automatic Updates (macOS)
- **Auto-updates**: Automatically checks for updates every 4 hours
- **Manual Check**: Check for updates anytime via Help → Check for Updates
- **Smart Installation**: Downloads in background, prompts when ready to install
- **Seamless Updates**: Update installs automatically on app quit

### Platform Support
- **macOS**: Fully signed and notarized, supports both Intel and Apple Silicon
- **Windows**: NSIS installer with desktop shortcuts
- **Linux**: Multiple formats (AppImage, DEB, RPM)

## How It Works

The desktop app connects to your PageSpace cloud instance at [www.pagespace.ai](https://www.pagespace.ai), providing a native experience with better system integration than using a web browser.

## Installation

**macOS**:
1. Download and open the DMG file
2. Drag PageSpace to Applications folder
3. Launch from Applications or Spotlight

**Windows**:
1. Download and run the installer
2. Follow installation wizard
3. Launch from Start Menu or Desktop

**Linux**:
- **AppImage**: Make executable and run
- **DEB/RPM**: Install with package manager

## Requirements

- Internet connection to connect to PageSpace cloud
- macOS 10.13+, Windows 10+, or modern Linux distribution

## Notes

- This is the first official desktop release with auto-update support
- Auto-updates are currently available for macOS only
- Windows and Linux users will need to download new versions manually
- The desktop app requires an active PageSpace account at www.pagespace.ai

## Feedback

Report issues or request features at: https://github.com/2witstudios/PageSpace/issues

---

**Built with**: Electron, Next.js, TypeScript
