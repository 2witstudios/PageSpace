# iOS AI Usage & Rate Limiting Implementation

## Overview
This document describes the implementation of AI usage monitoring and rate limiting display in the PageSpace iOS app, matching the functionality from the web application.

## Features Implemented

### 1. Rate Limiting Display
- Shows current AI usage against subscription tier limits
- Format: "Standard: 0/20", "Pro AI: 0/50", etc.
- Displayed in the chat view navigation bar title
- Toggles between usage display and conversation/agent name on tap

### 2. Model-Aware Rate Limits
- **PageSpace Standard** (`glm-4.5-air`): Shows standard tier usage
- **PageSpace Pro** (`glm-4.6`): Shows pro tier usage
- **Other Providers**: Shows standard tier usage

### 3. Subscription Tier Support
- **Free Tier**: 20 standard calls/day, 0 pro calls
- **Pro Tier**: 100 standard calls/day, 50 pro calls/day
- **Business Tier**: 500 standard calls/day, 100 pro calls/day

### 4. Real-time Updates
- Fetches usage on view appear
- Refreshes after each message sent
- Uses existing `/api/subscriptions/usage` endpoint

## Files Created

### Core/Models/UsageData.swift
Defines the data structures for usage API response:
- `UsageLimit`: Contains current, limit, and remaining counts
- `UsageData`: Contains subscription tier and both standard/pro limits

### Core/State/UsageState.swift
Observable state class for managing usage data:
- `fetchUsage()`: Fetches current usage from API
- `getRateLimitDisplay()`: Returns formatted display string based on provider/model/tier
- Handles loading and error states

### Core/Services/UsageService.swift
Service layer for API communication:
- `fetchUsageData()`: Calls `/api/subscriptions/usage` endpoint
- Returns structured UsageData

## Files Modified

### Core/Networking/APIEndpoints.swift
- Added `subscriptionUsage` endpoint constant

### Core/Managers/ConversationManager.swift
- Added `usageState` property for centralized usage state management

### Features/Chat/ChatView.swift
**Changes:**
1. Added `@State private var showUsageInTitle = true` for toggle state
2. Modified toolbar `.principal` item to toggle between usage and title on tap
3. Added `.onAppear` to fetch usage data when view loads
4. Modified `sendMessage()` to refresh usage after sending

**Default Behavior:**
- Default view shows rate limiting (e.g., "Standard: 0/20")
- Tap once: Shows conversation/agent name
- Tap again: Back to rate limiting

## Usage Display Logic

```swift
// PageSpace provider
if provider == "pagespace" {
    if model == "glm-4.6" {
        // Pro model - show pro usage
        return "Pro AI: \(usage.pro.current)/\(usage.pro.limit)"
    } else {
        // Standard model - show standard usage
        return "Standard: \(usage.standard.current)/\(usage.standard.limit)"
    }
}

// Other providers use standard limits
return "AI: \(usage.standard.current)/\(usage.standard.limit)"
```

## API Integration

### Endpoint
`GET /api/subscriptions/usage`

### Response Structure
```json
{
  "subscriptionTier": "free" | "pro" | "business",
  "standard": {
    "current": 0,
    "limit": 20,
    "remaining": 20
  },
  "pro": {
    "current": 0,
    "limit": 0,
    "remaining": 0
  }
}
```

## Testing Checklist

- [ ] Free user with Standard model shows "Standard: 0/20"
- [ ] Pro user with Standard model shows "Standard: 0/100"
- [ ] Pro user with Pro model shows "Pro AI: 0/50"
- [ ] Business user with Pro model shows "Pro AI: 0/100"
- [ ] Tapping title toggles between name and usage
- [ ] Usage updates when view appears
- [ ] Usage updates after sending message
- [ ] Loading state shows "Loading..."
- [ ] Error state shows "Usage unavailable"
- [ ] Works with Global Assistant
- [ ] Works with Page AI
- [ ] Works with Drive AI

## Design Decisions

### Toggle Behavior
**Chosen:** Toggle on tap (default shows usage)
- Simple, minimal UI
- User has control over what's displayed
- Matches user's preference for "low-key" design

### Detail Level
**Chosen:** Rate limiting only (no token details)
- Keeps UI clean and minimal
- Focuses on most important metric (rate limits)
- Avoids cluttering the navigation bar

### Refresh Strategy
**Chosen:** On view appear + after message sent
- Balances freshness with API load
- No background polling (battery friendly)
- Updates when most relevant (user action)

### Visual Style
**Chosen:** Neutral gray color (no color coding)
- Consistent with user preference for minimal design
- Less visual noise
- Professional appearance

## Future Enhancements

Potential improvements if needed:
1. Socket.IO real-time updates (if iOS Socket.IO support added)
2. Pull-to-refresh gesture for manual updates
3. Detailed token usage view (separate screen)
4. Color coding option in settings
5. Periodic background refresh (low frequency)

## Notes

- No backend changes required - uses existing web app API
- Matches web app behavior for consistency
- Follows iOS app's state management patterns (Observable)
- Integrates seamlessly with ConversationManager architecture
