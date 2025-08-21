# Admin API

## Overview

The Admin API provides administrative and monitoring capabilities for PageSpace system management. These endpoints require elevated permissions and are designed for system administrators, monitoring tools, and development/debugging purposes.

**Security Note:** All admin endpoints require proper authentication and admin-level permissions. Access is logged and monitored.

## Admin Routes

### GET /api/admin/users

**Purpose:** Administrative user management with complete statistics including drives, pages, messages, and AI settings.
**Auth Required:** Yes (Admin role)
**Request Schema:** None
**Response Schema:** Array of user objects with extended statistics:
- id: string
- name: string
- email: string
- createdAt: timestamp
- lastLoginAt: timestamp
- driveCount: number
- pageCount: number
- messageCount: number
- aiProviderSettings: object
**Implementation Notes:**
- Aggregates statistics across all user data
- Used for admin dashboard and user management
**Status Codes:** 200 (OK), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

### GET /api/admin/schema

**Purpose:** Provides database schema information for administrative tools.
**Auth Required:** Yes (Admin role)
**Request Schema:** None
**Response Schema:** Database schema object with tables and relationships.
**Implementation Notes:**
- Returns Drizzle ORM schema definitions
- Used for database management tools and migrations
- Includes table structure, indexes, and foreign keys
**Status Codes:** 200 (OK), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

## Monitoring Routes

### GET /api/monitoring/[metric]

**Purpose:** Returns monitoring data for the specified metric.
**Auth Required:** Yes (Admin role may be required for some metrics)
**Request Schema:**
- metric: string (dynamic parameter - must await context.params in Next.js 15)
- range: string (query parameter - '24h' | '7d' | '30d' | 'all', default '24h')
**Available Metrics:**
- 'system-health': System health indicators
- 'api-metrics': API performance metrics
- 'user-activity': User activity patterns
- 'ai-usage': AI usage statistics
- 'error-analytics': Error rates and patterns
- 'performance': Performance metrics
**Response Schema:** Metric-specific data object.
**Implementation Notes:**
- Uses Next.js 15 async params pattern
- Data aggregated based on date range
- OpenTelemetry integration for metrics collection
**Status Codes:** 200 (OK), 401 (Unauthorized), 404 (Not Found), 500 (Internal Server Error)
**Next.js 15 Handler:** async function with await context.params
**Last Updated:** 2025-08-21

## Tracking Routes

### POST /api/track

**Purpose:** Tracks user activity and analytics events.
**Auth Required:** No (client-side tracking)
**Request Schema:**
- event: string
- properties: object (optional)
- timestamp: string (optional)
**Response Schema:** Success acknowledgment.
**Implementation Notes:**
- Used for analytics and monitoring
- Non-blocking, fire-and-forget
- Integrates with OpenTelemetry for metrics
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
- Provided for client compatibility
**Status Codes:** 200 (OK), 400 (Bad Request), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning Response
**Last Updated:** 2025-08-21

## Debug Routes

### GET /api/debug/chat-messages

**Purpose:** Debug endpoint for viewing chat messages (development only).
**Auth Required:** Yes (Admin or debug mode)
**Request Schema:**
- pageId: string (query parameter - optional)
- limit: number (query parameter - optional)
**Response Schema:** Array of chat messages with debug information.
**Implementation Notes:**
- Should be disabled in production
- Includes additional debug metadata
- Used for troubleshooting AI conversations
**Status Codes:** 200 (OK), 401 (Unauthorized), 403 (Forbidden), 500 (Internal Server Error)
**Next.js 15 Handler:** async function returning NextResponse
**Last Updated:** 2025-08-21

## Monitoring Metrics Details

### System Health
- **CPU Usage:** Process CPU utilization
- **Memory Usage:** Heap and RSS memory consumption
- **Database Connections:** Active connection pool status
- **Response Times:** Average API response times
- **Error Rates:** HTTP error rates by endpoint

### API Metrics
- **Request Volume:** Requests per minute/hour
- **Response Times:** P50, P95, P99 latency percentiles
- **Error Rates:** 4xx and 5xx error percentages
- **Endpoint Performance:** Per-route performance metrics

### User Activity
- **Active Users:** Daily/weekly/monthly active users
- **Page Views:** Most accessed pages and drives
- **Feature Usage:** AI usage, collaboration metrics
- **Session Duration:** Average session lengths

### AI Usage
- **Provider Distribution:** Usage across AI providers
- **Model Usage:** Popular models and usage patterns
- **Token Consumption:** Estimated token usage and costs
- **Response Times:** AI response latency metrics

### Error Analytics
- **Error Frequency:** Error rates over time
- **Error Distribution:** Common error types and causes
- **User Impact:** Errors affecting user experience
- **Resolution Times:** Time to error resolution

### Performance
- **Database Performance:** Query execution times
- **Cache Hit Rates:** Redis and application cache performance
- **Real-time Metrics:** Socket.IO connection and message metrics
- **Resource Utilization:** Server resource consumption

## Security and Access Control

### Admin Role Requirements
- **User Management:** Full admin role required
- **System Monitoring:** Read-only admin access sufficient
- **Debug Endpoints:** Debug mode or admin role required
- **Schema Access:** Full admin role required

### Audit Logging
All admin API access is logged with:
- User ID and role
- Endpoint accessed
- Request parameters
- Response status
- Timestamp

### Rate Limiting
Admin endpoints have elevated rate limits but are still protected against abuse:
- **Standard Admin Endpoints:** 1000 requests per hour
- **Monitoring Endpoints:** 10000 requests per hour
- **Debug Endpoints:** 100 requests per hour

## OpenTelemetry Integration

The monitoring system integrates with OpenTelemetry for comprehensive observability:

```typescript
// Metrics collection example
const meter = metrics.getMeter('pagespace-admin');
const requestCounter = meter.createCounter('api_requests_total');
const responseTimeHistogram = meter.createHistogram('api_response_time');

// Usage in API handlers
requestCounter.add(1, { endpoint: '/api/admin/users', method: 'GET' });
responseTimeHistogram.record(responseTime, { endpoint: '/api/admin/users' });
```

## Error Handling

Admin APIs provide detailed error information for debugging:

```json
{
  "error": "Database connection failed",
  "code": "DB_CONNECTION_ERROR", 
  "details": {
    "retryAfter": 30,
    "affectedServices": ["user-stats", "monitoring"]
  },
  "timestamp": "2025-08-21T10:30:00Z",
  "requestId": "req_123456789"
}
```