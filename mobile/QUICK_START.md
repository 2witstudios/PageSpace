# PageSpace Mobile - Quick Start Guide

**Get the iOS companion app running in 5 minutes.**

---

## Prerequisites

- ✅ macOS 13+ with Xcode 15+
- ✅ PageSpace backend running (`pnpm dev` in main directory)
- ✅ iOS 17+ device or simulator

---

## Steps

### 1. Start Backend

```bash
# In PageSpace root directory
pnpm dev

# Verify services:
# - Web: http://localhost:3000 ✅
# - Realtime: http://localhost:3001 ✅
# - Processor: http://localhost:3003 ✅
```

### 2. Open Mobile Project

```bash
cd mobile
open Package.swift  # Opens in Xcode
```

Wait for dependencies to resolve (~30 seconds first time).

### 3. Configure Backend URL

**For Simulator** (default):
- Already set to `http://localhost:3000` ✅

**For Physical Device**:
1. Find Mac IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
2. Edit `PageSpaceMobile/App/Configuration/Environment.swift`:
   ```swift
   return URL(string: "http://192.168.1.100:3000")!  // Your Mac IP
   ```

### 4. Build & Run

1. Select target device (iPhone 15 simulator recommended)
2. Press `Cmd + R`
3. Wait for build (~1 minute first time)

### 5. Login

Use existing PageSpace user credentials:
- Email: `your-email@example.com`
- Password: `your-password`

---

## Verify Setup

### ✅ Checklist

- [ ] App launches without crash
- [ ] Login screen appears
- [ ] Can log in successfully
- [ ] Conversations list loads
- [ ] Can send message and see AI streaming response
- [ ] Messages render with text and tool parts

### ❌ Troubleshooting

**"Cannot connect to backend"**
```bash
# Check backend is running
curl http://localhost:3000/api/auth/login

# Check firewall (macOS)
System Preferences → Security → Firewall → Allow incoming connections
```

**"Build failed"**
```
File → Packages → Reset Package Caches
Cmd + Shift + K (Clean Build Folder)
Cmd + B (Rebuild)
```

**"Login fails"**
- Verify user exists in backend database
- Check backend logs for errors
- Ensure correct email/password

---

## Next Steps

### Test Core Features

1. **Create Conversation**
   - Tap `+` in conversation list
   - Conversation appears instantly

2. **Send Message**
   - Open conversation
   - Type message → Send
   - Watch AI stream response in real-time

3. **View Tool Calls**
   - Ask AI to search or read content
   - Tool calls render as collapsible sections
   - Tap to expand input/output

### Explore Code

**Key Files**:
- `ChatView.swift` - Main chat interface (203 lines)
- `ChatViewModel.swift` - Message streaming logic (150 lines)
- `APIClient.swift` - HTTP + SSE client (200 lines)
- `Message.swift` - Data models (150 lines)

### Read Documentation

- [Setup Guide](SETUP.md) - Detailed setup instructions
- [Architecture](docs/ARCHITECTURE.md) - System design overview
- [API Contract](docs/API_CONTRACT.md) - Backend API reference
- [Authentication Flow](docs/AUTHENTICATION_FLOW.md) - Auth implementation

---

## Development Workflow

### Make Changes

```bash
# 1. Edit Swift files in Xcode
# 2. Preview changes: Cmd + Opt + P
# 3. Run tests: Cmd + U
# 4. Build & run: Cmd + R
```

### Add Features

**Example: Add voice input**

1. Create `VoiceInputButton.swift` in `Shared/Components/`
2. Add to `ChatView.swift`
3. Integrate with Whisper API
4. Test on device (mic required)

### Debug Issues

**View logs**:
```
Window → Devices and Simulators → Select device → Open Console
```

**Set breakpoints**:
- Click line number in Xcode
- Run in debug mode (Cmd + R)

---

## Deploy to TestFlight

```bash
# 1. Archive
Xcode → Product → Archive

# 2. Validate
Window → Organizer → Validate App

# 3. Upload
Distribute App → TestFlight → Upload

# 4. Add testers
App Store Connect → TestFlight → Add Internal Testers
```

---

## Support

**Issues?**
1. Check [Troubleshooting](SETUP.md#troubleshooting)
2. Review [Architecture](docs/ARCHITECTURE.md)
3. Search existing issues
4. Contact dev team

---

## Quick Reference

### Useful Commands

```bash
# Build project
swift build

# Run tests
swift test

# Clean build
rm -rf .build DerivedData

# Find Mac IP
ifconfig | grep "inet "

# Check backend health
curl http://localhost:3000/api/auth/login
```

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd + R` | Build and run |
| `Cmd + U` | Run tests |
| `Cmd + B` | Build only |
| `Cmd + Shift + K` | Clean build folder |
| `Cmd + Opt + P` | Refresh SwiftUI preview |
| `Cmd + .` | Stop running app |

---

## Success! 🎉

You now have:
- ✅ Working mobile app
- ✅ AI chat with streaming
- ✅ Message history
- ✅ Tool call rendering

**Next**: Read [Architecture](docs/ARCHITECTURE.md) to understand the system design.
