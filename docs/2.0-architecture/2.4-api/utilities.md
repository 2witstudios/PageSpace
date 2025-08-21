# Utilities API

## Overview

The Utilities API provides supporting functionality for PageSpace applications, including client-side tracking, dynamic styling, and system utilities. These endpoints are designed to support the core application functionality without requiring complex authentication or business logic.

## API Routes

### POST /api/track

**Purpose:** Tracks user activity and analytics events.
**Auth Required:** No (client-side tracking)
**Request Schema:**
- event: string (event name/type)
- properties: object (optional - additional event data)
- timestamp: string (optional - ISO timestamp)
- userId: string (optional - user identifier)
- sessionId: string (optional - session identifier)
**Response Schema:** Success acknowledgment.
```json
{
  "success": true,
  "eventId": "evt_123456789",
  "timestamp": "2025-08-21T10:30:00Z"
}
```
**Implementation Notes:**
- Used for analytics and monitoring
- Non-blocking, fire-and-forget operation
- Integrates with OpenTelemetry for metrics collection
- Supports batching for performance
**Status Codes:** 200 (OK), 400 (Bad Request), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response
**Last Updated:** 2025-08-21

### PUT /api/track

**Purpose:** Alternative method for tracking events (supports different client requirements).
**Auth Required:** No
**Request Schema:** Same as POST /api/track
**Response Schema:** Success acknowledgment.
**Implementation Notes:**
- Identical functionality to POST method
- Provided for client compatibility (some analytics libraries prefer PUT)
- Same performance characteristics as POST
**Status Codes:** 200 (OK), 400 (Bad Request), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response
**Last Updated:** 2025-08-21

### GET /api/compiled-css

**Purpose:** Returns compiled CSS for dynamic theming and styling.
**Auth Required:** No
**Request Schema:**
- theme: string (query parameter - optional, 'light' | 'dark' | 'auto')
- variant: string (query parameter - optional, custom theme variant)
- cache: boolean (query parameter - optional, enable/disable caching)
**Response Schema:** Compiled CSS string with appropriate content-type.
**Implementation Notes:**
- Caches compiled CSS for performance
- Supports custom themes and variants
- Returns CSS with proper MIME type (text/css)
- Implements HTTP caching headers
**Status Codes:** 200 (OK), 400 (Bad Request), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response with CSS content-type
**Last Updated:** 2025-08-21

## Event Tracking Details

### Supported Event Types

#### Page Views
```json
{
  "event": "page_view",
  "properties": {
    "path": "/dashboard/project-alpha",
    "title": "Project Alpha Dashboard",
    "driveId": "drive_123",
    "pageId": "page_456",
    "referrer": "https://pagespace.app/dashboard"
  }
}
```

#### Feature Usage
```json
{
  "event": "feature_used",
  "properties": {
    "feature": "ai_assistant",
    "action": "message_sent",
    "provider": "openrouter",
    "model": "claude-3.5-sonnet",
    "contextType": "global"
  }
}
```

#### User Interactions
```json
{
  "event": "user_interaction",
  "properties": {
    "element": "create_page_button",
    "pageType": "document",
    "location": "sidebar",
    "driveId": "drive_123"
  }
}
```

#### Error Events
```json
{
  "event": "error",
  "properties": {
    "type": "api_error",
    "endpoint": "/api/pages/123",
    "statusCode": 500,
    "errorMessage": "Internal server error",
    "stack": "Error: ...",
    "userAgent": "Mozilla/5.0..."
  }
}
```

#### Performance Metrics
```json
{
  "event": "performance",
  "properties": {
    "metric": "page_load_time",
    "value": 1250,
    "unit": "milliseconds",
    "path": "/dashboard/project-alpha"
  }
}
```

### Privacy and Data Collection

#### Data Minimization
- Only necessary data is collected
- No personally identifiable information unless explicitly needed
- Events are aggregated for analytics

#### Retention Policy
- Raw event data retained for 30 days
- Aggregated analytics retained for 1 year
- Error events retained for 90 days for debugging

#### Opt-out Support
Users can opt out of analytics tracking:
```javascript
// Client-side opt-out
localStorage.setItem('analytics_opt_out', 'true');
```

## Dynamic CSS Theming

### Theme System
PageSpace supports dynamic theming through the compiled CSS endpoint:

#### Light Theme
```css
:root {
  --background: #ffffff;
  --foreground: #000000;
  --primary: #2563eb;
  --secondary: #64748b;
}
```

#### Dark Theme
```css
:root {
  --background: #0a0a0a;
  --foreground: #ffffff;
  --primary: #3b82f6;
  --secondary: #94a3b8;
}
```

### Custom Theme Variables
The CSS compilation supports custom theme variables:
```http
GET /api/compiled-css?theme=custom&primary=ff6b6b&background=f8f9fa
```

### Caching Strategy
- CSS is cached in memory for 1 hour
- Browser caching enabled with proper ETags
- Invalidated when theme definitions change

## Performance Considerations

### Analytics Batching
Multiple tracking events can be batched for efficiency:
```javascript
// Batch multiple events
await fetch('/api/track', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    events: [
      { event: 'page_view', properties: { path: '/dashboard' } },
      { event: 'feature_used', properties: { feature: 'search' } }
    ]
  })
});
```

### CSS Optimization
- Compiled CSS is minified in production
- Unused CSS rules are purged
- Critical CSS is inlined for performance

### Rate Limiting
Utility endpoints have generous rate limits:
- **Tracking endpoints:** 10,000 requests per hour
- **CSS endpoint:** 1,000 requests per hour (due to caching)

## Integration Examples

### Client-Side Analytics
```javascript
// Track page view
function trackPageView(path) {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'page_view',
      properties: { path },
      timestamp: new Date().toISOString()
    })
  }).catch(console.error); // Fail silently
}

// Track feature usage
function trackFeature(feature, action, properties = {}) {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'feature_used',
      properties: { feature, action, ...properties }
    })
  }).catch(console.error);
}
```

### Dynamic Theme Loading
```javascript
// Load theme CSS
function loadTheme(theme) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/api/compiled-css?theme=${theme}`;
  document.head.appendChild(link);
}

// Switch themes
function switchTheme(newTheme) {
  // Remove existing theme
  const existing = document.querySelector('link[href*="compiled-css"]');
  if (existing) existing.remove();
  
  // Load new theme
  loadTheme(newTheme);
  
  // Track theme change
  trackFeature('theming', 'theme_changed', { theme: newTheme });
}
```

## Error Handling

### Tracking Errors
Tracking endpoints are designed to fail silently to avoid impacting user experience:
```javascript
fetch('/api/track', { /* ... */ })
  .catch(error => {
    // Log error for debugging but don't show to user
    console.debug('Analytics tracking failed:', error);
  });
```

### CSS Loading Errors
CSS endpoint errors should have fallbacks:
```javascript
async function loadThemeWithFallback(theme) {
  try {
    const response = await fetch(`/api/compiled-css?theme=${theme}`);
    if (!response.ok) throw new Error('CSS load failed');
    return response.text();
  } catch (error) {
    console.warn('Theme loading failed, using default');
    return fetch('/api/compiled-css').then(r => r.text());
  }
}
```