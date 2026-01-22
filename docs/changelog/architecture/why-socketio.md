# Why Socket.IO

> Real-time architecture for live collaboration

## The Decision

Socket.IO powers PageSpace's real-time collaboration features. It runs as a separate service (`apps/realtime`) rather than being embedded in the Next.js app.

## Key Architectural Choices

### Socket.IO Over Alternatives

**The Choice**: Socket.IO instead of raw WebSockets, Pusher, or Ably.

**Why**:
- Automatic fallback transports
- Room-based broadcasting
- Reconnection handling built-in
- Large ecosystem and documentation
- Self-hosted (no external service dependency)

**Trade-offs**:
- More overhead than raw WebSockets
- Requires dedicated server process
- Not edge-native (unlike some modern alternatives)

### Separate Service Architecture

**The Choice**: Real-time as `apps/realtime` on port 3001.

**Why**:
- Independent scaling from the web app
- Can be deployed on dedicated infrastructure
- Clear separation of concerns
- Stateful connections isolated from stateless API

**Trade-offs**:
- Additional deployment complexity
- Cross-origin considerations
- Authentication token sharing

### Event Broadcasting Patterns

*To be documented as commits reveal specific patterns:*
- Document update events
- Presence indicators
- Conflict resolution
- Room management

## Integration Points

### Web App Integration

```typescript
// Socket connection from the web app
import { io } from 'socket.io-client';

const socket = io(process.env.NEXT_PUBLIC_REALTIME_URL);
```

### Authentication Flow

*To be documented based on commit analysis.*

## Evolution Through Commits

*This section will track real-time feature evolution:*
- Initial setup (Era 1)
- Collaboration features (Era 4)
- Performance improvements
- Security enhancements

---

*Last updated: 2026-01-21 | Version: 0*
