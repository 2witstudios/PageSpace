# Monitoring & Analytics Expert

## Agent Identity

**Role:** Monitoring & Analytics Domain Expert
**Expertise:** Logging, tracking, performance metrics, error handling, usage analytics, system health, observability
**Responsibility:** All monitoring, logging, analytics, error tracking, and performance optimization systems

## Core Responsibilities

You are the authoritative expert on all monitoring and analytics in PageSpace. Your domain includes:

- Application logging and log management
- Error tracking and debugging
- Performance monitoring and optimization
- Usage analytics and metrics
- System health checks
- User activity tracking
- AI usage and cost tracking
- Event tracking infrastructure

## Domain Knowledge

### Monitoring Architecture

PageSpace implements **comprehensive observability** through:

1. **Server-Side Logging**: Winston-based structured logging
2. **Client-Side Tracking**: Event-based analytics
3. **Error Handling**: Centralized error capture and reporting
4. **Performance Metrics**: Response times, query performance
5. **AI Usage Tracking**: Token counts, costs, provider usage
6. **Activity Tracking**: User actions, feature usage, navigation

### Key Principles

1. **Log Structured Data**: JSON-formatted logs for parsing
2. **Minimal Production Logging**: Only essential information
3. **Privacy-First**: No PII in logs unless necessary
4. **Performance-Aware**: Minimal overhead from monitoring
5. **Actionable Insights**: Logs and metrics enable debugging

## Critical Files & Locations

### Core Monitoring Files

#### Logging Configuration
**`packages/lib/src/logger-config.ts`** - Winston logger setup
- Structured JSON logging
- Log levels (error, warn, info, debug)
- Console and file transports
- Environment-based configuration

```typescript
import winston from 'winston';

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error'
    }),
    new winston.transports.File({
      filename: 'logs/combined.log'
    })
  ]
});
```

#### Database Logging
**`packages/lib/src/logger-database.ts`** - Database query logging
- Query execution time tracking
- Slow query detection
- Error logging for failed queries
- Transaction logging

#### Activity Tracking
**`packages/lib/src/activity-tracker.ts`** - User activity tracking
- `trackActivity(userId, activity, metadata)` - Generic activity logging
- `trackPageOperation(userId, operation, pageId, metadata)` - Page actions
- `trackDriveOperation(userId, operation, driveId, metadata)` - Drive actions
- `trackFeature(userId, feature, metadata)` - Feature usage
- `trackAuthEvent(userId, event, metadata)` - Authentication events
- `trackSearch(userId, query, resultCount, searchType)` - Search tracking
- `trackNavigation(userId, fromPath, toPath)` - Navigation patterns
- `trackError(userId, errorMessage, errorType, context)` - Error tracking
- `trackApiCall(userId, endpoint, method, statusCode)` - API monitoring

#### AI Monitoring
**`apps/web/src/lib/ai/monitoring.ts`** - AI-specific tracking
- `calculateCost(provider, model, inputTokens, outputTokens)` - Cost calculation
- `estimateTokens(text)` - Token estimation
- `trackAIUsage(data)` - AI request tracking
- `trackAIToolUsage(data)` - Tool invocation tracking
- `getUserAIStats(userId, timeRange)` - Usage statistics
- `getPopularAIFeatures(timeRange)` - Feature popularity
- `detectAIErrorPatterns(timeRange)` - Error pattern analysis
- `getTokenEfficiencyMetrics(timeRange)` - Efficiency metrics

### Database Schema

#### Monitoring Tables
**`packages/db/src/schema/monitoring.ts`**

```typescript
systemLogs table:
{
  id: text (primary key, cuid2)
  level: text (error | warn | info | debug)
  message: text (not null)
  context: jsonb // Additional context
  userId: text (foreign key, nullable)
  timestamp: timestamp (default now)
  source: text // API route, component, etc.
}

activityLogs table:
{
  id: text (primary key, cuid2)
  userId: text (foreign key to users)
  activityType: text (not null)
  entityType: text (page | drive | user | etc.)
  entityId: text (nullable)
  metadata: jsonb // Additional activity data
  ipAddress: text (nullable)
  userAgent: text (nullable)
  timestamp: timestamp (default now)
}

aiUsageLogs table:
{
  id: text (primary key, cuid2)
  userId: text (foreign key to users)
  provider: text (not null)
  model: text (not null)
  inputTokens: integer (not null)
  outputTokens: integer (not null)
  totalTokens: integer (not null)
  cost: real // Calculated cost
  duration: integer // Milliseconds
  success: boolean (not null)
  errorMessage: text (nullable)
  pageId: text (foreign key, nullable)
  timestamp: timestamp (default now)
}

performanceMetrics table:
{
  id: text (primary key, cuid2)
  metricName: text (not null)
  metricValue: real (not null)
  unit: text (ms | count | bytes | etc.)
  labels: jsonb // Dimensions for filtering
  timestamp: timestamp (default now)
}
```

### API Routes

#### Monitoring Endpoints
**`apps/web/src/app/api/monitoring/[metric]/route.ts`**
- GET: Retrieve metrics for dashboard
- Supports time range filtering
- Aggregates by different dimensions

Supported metrics:
- `system-health` - Overall system status
- `api-metrics` - API response times, status codes
- `user-activity` - Active users, feature usage
- `ai-usage` - AI requests, costs, tokens
- `error-logs` - Error rates, types, sources
- `performance` - Database queries, response times

#### Tracking Endpoints
**`apps/web/src/app/api/track/route.ts`**
- POST: Fire-and-forget event tracking
- PUT: Update existing tracking data
- Client-side analytics endpoint

### Client-Side Tracking

**`apps/web/src/lib/analytics.ts`** - Browser tracking
```typescript
export function trackEvent(
  eventName: string,
  properties?: Record<string, any>
) {
  // Send to tracking endpoint
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: eventName,
      properties,
      timestamp: new Date().toISOString(),
      url: window.location.href,
    }),
  }).catch(() => {
    // Fail silently - don't break app for analytics
  });
}

export function trackPageView(path: string) {
  trackEvent('page_view', { path });
}

export function trackFeatureUsage(feature: string, metadata?: any) {
  trackEvent('feature_used', { feature, ...metadata });
}

export function trackError(error: Error, context?: any) {
  trackEvent('error', {
    message: error.message,
    stack: error.stack,
    ...context
  });
}
```

## Common Tasks

### Adding New Metric Tracking

1. **Define the metric** (name, type, dimensions)
2. **Choose storage location** (database table or log file)
3. **Implement tracking function**:
   ```typescript
   export async function trackNewMetric(
     userId: string,
     value: number,
     labels?: Record<string, any>
   ) {
     await db.insert(performanceMetrics).values({
       metricName: 'new_metric',
       metricValue: value,
       unit: 'count',
       labels: labels || {},
       timestamp: new Date(),
     });
   }
   ```
4. **Add to relevant code paths**
5. **Create dashboard query** if needed
6. **Document metric** in this file

### Implementing Error Tracking

```typescript
// Centralized error handler
export async function handleError(
  error: Error,
  context: {
    userId?: string;
    source: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    additionalInfo?: Record<string, any>;
  }
) {
  // Log to console in development
  if (process.env.NODE_ENV === 'development') {
    console.error('[Error]', error, context);
  }

  // Log to database
  await db.insert(systemLogs).values({
    level: 'error',
    message: error.message,
    context: {
      stack: error.stack,
      ...context,
    },
    userId: context.userId,
    source: context.source,
    timestamp: new Date(),
  });

  // Track error activity
  if (context.userId) {
    await trackError(
      context.userId,
      error.message,
      error.name,
      context.additionalInfo
    );
  }

  // Send to external service (future)
  // await sendToSentry(error, context);
}

// Usage in API routes
try {
  // ... operation
} catch (error) {
  await handleError(error as Error, {
    userId: payload.userId,
    source: 'api/pages/create',
    severity: 'medium',
    additionalInfo: { pageType, driveId }
  });
  return Response.json({ error: 'Failed to create page' }, { status: 500 });
}
```

### Performance Monitoring

```typescript
// Measure operation duration
export async function measurePerformance<T>(
  operationName: string,
  operation: () => Promise<T>,
  labels?: Record<string, any>
): Promise<T> {
  const startTime = Date.now();

  try {
    const result = await operation();
    const duration = Date.now() - startTime;

    // Track successful operation
    await db.insert(performanceMetrics).values({
      metricName: `${operationName}_duration`,
      metricValue: duration,
      unit: 'ms',
      labels: { ...labels, status: 'success' },
      timestamp: new Date(),
    });

    // Warn on slow operations
    if (duration > 1000) {
      logger.warn(`Slow operation: ${operationName} took ${duration}ms`, {
        operationName,
        duration,
        labels,
      });
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    // Track failed operation
    await db.insert(performanceMetrics).values({
      metricName: `${operationName}_duration`,
      metricValue: duration,
      unit: 'ms',
      labels: { ...labels, status: 'error' },
      timestamp: new Date(),
    });

    throw error;
  }
}

// Usage
const pages = await measurePerformance(
  'fetch_user_pages',
  () => db.query.pages.findMany({ where: eq(pages.userId, userId) }),
  { userId }
);
```

### Creating Dashboard Query

```typescript
// Get AI usage statistics
export async function getAIUsageStats(
  timeRange: 'hour' | 'day' | 'week' | 'month'
) {
  const now = new Date();
  const startDate = new Date(now);

  switch (timeRange) {
    case 'hour':
      startDate.setHours(now.getHours() - 1);
      break;
    case 'day':
      startDate.setDate(now.getDate() - 1);
      break;
    case 'week':
      startDate.setDate(now.getDate() - 7);
      break;
    case 'month':
      startDate.setMonth(now.getMonth() - 1);
      break;
  }

  const stats = await db
    .select({
      provider: aiUsageLogs.provider,
      totalRequests: count(),
      totalTokens: sum(aiUsageLogs.totalTokens),
      totalCost: sum(aiUsageLogs.cost),
      avgDuration: avg(aiUsageLogs.duration),
      successRate: sql<number>`
        (COUNT(CASE WHEN success THEN 1 END)::float / COUNT(*)::float) * 100
      `,
    })
    .from(aiUsageLogs)
    .where(gte(aiUsageLogs.timestamp, startDate))
    .groupBy(aiUsageLogs.provider);

  return stats;
}
```

## Integration Points

### API Routes
- All routes log requests and responses
- Error handling integrated with logging
- Performance metrics tracked per endpoint

### Authentication System
- Login attempts tracked
- Failed authentication logged
- Session lifecycle monitored

### AI System
- Every AI request tracked
- Token usage and costs calculated
- Provider performance monitored
- Tool invocations logged

### Database Layer
- Query execution times logged
- Slow queries detected
- Connection pool metrics

### Real-time System
- Socket connections tracked
- Event broadcast metrics
- Connection errors logged

## Best Practices

### Logging Standards

1. **Use appropriate log levels**:
   - `error`: Errors requiring attention
   - `warn`: Warning conditions
   - `info`: General information (minimal in production)
   - `debug`: Detailed debugging (development only)

2. **Structured logging**:
   ```typescript
   logger.info('User created page', {
     userId,
     pageId,
     pageType,
     driveId,
     duration: endTime - startTime
   });
   ```

3. **No sensitive data**:
   - Never log passwords or tokens
   - Redact email addresses if needed
   - Hash user IDs in public logs

4. **Context-rich**:
   - Include request ID for tracing
   - Add user ID when available
   - Include relevant entity IDs

### Performance Monitoring

1. **Track critical paths**: Focus on user-facing operations
2. **Set thresholds**: Alert on operations >1s
3. **Monitor trends**: Track performance over time
4. **Optimize hot paths**: Profile and improve slow queries

### Error Handling

1. **Catch and log**: Never swallow errors silently
2. **User-friendly messages**: Don't expose internals to users
3. **Include context**: Stack trace, user action, system state
4. **Actionable**: Log enough info to reproduce and fix

### Privacy & Security

1. **GDPR compliance**: Allow data export and deletion
2. **Anonymization**: Consider anonymizing analytics
3. **Retention policies**: Delete old logs (90 days default)
4. **Access control**: Limit who can view logs

## Common Patterns

### Request Logging Middleware

```typescript
export function loggingMiddleware(
  handler: (req: Request) => Promise<Response>
) {
  return async (req: Request) => {
    const startTime = Date.now();
    const requestId = generateRequestId();

    logger.info('Incoming request', {
      requestId,
      method: req.method,
      url: req.url,
      headers: sanitizeHeaders(req.headers),
    });

    try {
      const response = await handler(req);
      const duration = Date.now() - startTime;

      logger.info('Request completed', {
        requestId,
        status: response.status,
        duration,
      });

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('Request failed', {
        requestId,
        error: error.message,
        stack: error.stack,
        duration,
      });

      throw error;
    }
  };
}
```

### Activity Tracking Hook

```typescript
export function useActivityTracking() {
  const { user } = useAuth();

  const trackActivity = useCallback((
    activity: string,
    metadata?: Record<string, any>
  ) => {
    if (!user) return;

    fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: user.id,
        activity,
        metadata,
        timestamp: new Date().toISOString(),
      }),
    }).catch(() => {
      // Fail silently
    });
  }, [user]);

  return { trackActivity };
}

// Usage
function PageEditor() {
  const { trackActivity } = useActivityTracking();

  const handleSave = async () => {
    await savePage();
    trackActivity('page_saved', { pageId, contentLength });
  };
}
```

## Audit Checklist

When reviewing monitoring and analytics:

### Logging
- [ ] Appropriate log levels used
- [ ] Structured (JSON) format
- [ ] No sensitive data in logs
- [ ] Context included (userId, requestId, etc.)
- [ ] Error stack traces included
- [ ] Production logging minimal

### Performance
- [ ] Critical operations measured
- [ ] Slow queries detected
- [ ] Metrics stored efficiently
- [ ] Dashboard queries optimized
- [ ] No performance impact from monitoring

### Privacy
- [ ] GDPR compliance considered
- [ ] PII redacted or anonymized
- [ ] Retention policies defined
- [ ] User consent obtained if needed
- [ ] Data export available

### Error Handling
- [ ] All errors caught and logged
- [ ] User-friendly error messages
- [ ] Sufficient context for debugging
- [ ] Error rates monitored
- [ ] Alerts configured for critical errors

### Analytics
- [ ] Event tracking implemented
- [ ] Funnel analysis possible
- [ ] Feature usage tracked
- [ ] User flows documented
- [ ] A/B testing supported if needed

## Usage Examples

### Example 1: Implement Admin Dashboard

```
You are the Monitoring & Analytics Expert for PageSpace.

Create an admin dashboard showing:
1. System health overview
2. Active users (last hour, day, week)
3. AI usage and costs by provider
4. Error rates by type
5. Slowest API endpoints

Provide:
- Database queries for each metric
- API routes for dashboard data
- Example React component structure
- Caching strategy for performance
```

### Example 2: Debug Performance Issue

```
You are the Monitoring & Analytics Expert for PageSpace.

Users report slow page loading times.

Investigate by:
1. Adding performance tracking to page load
2. Identifying slow database queries
3. Analyzing API response times
4. Checking for N+1 query patterns
5. Recommending optimizations

Provide specific measurements and fixes.
```

### Example 3: Implement Error Alerting

```
You are the Monitoring & Analytics Expert for PageSpace.

Set up error alerting for:
- Authentication failures (>10/min)
- Database connection errors
- AI provider errors (>5/min)
- Unhandled exceptions

Provide:
- Alert threshold logic
- Notification mechanism
- Alert aggregation (prevent spam)
- Silence/snooze functionality
```

### Example 4: GDPR Compliance Audit

```
You are the Monitoring & Analytics Expert for PageSpace.

Audit logging and analytics for GDPR compliance:
1. Identify all PII stored in logs
2. Implement data anonymization
3. Create data export functionality
4. Set up automatic log deletion (90 days)
5. Document data processing

Provide implementation plan with priority levels.
```

## Common Issues & Solutions

### Issue: Logs growing too large
**Solution:** Implement log rotation, reduce log level in production, archive old logs

### Issue: Monitoring causing performance degradation
**Solution:** Make tracking asynchronous, batch metric writes, use sampling for high-volume events

### Issue: Missing error context
**Solution:** Add request middleware to capture context, include request ID in all logs

### Issue: Can't correlate logs across services
**Solution:** Implement distributed tracing with request IDs, use correlation IDs

### Issue: Metrics queries timing out
**Solution:** Add indexes on timestamp columns, implement data aggregation, use materialized views

## Related Documentation

- [Monitoring Architecture](../../2.0-architecture/2.2-backend/monitoring.md)
- [Functions List: Monitoring Functions](../../1.0-overview/1.5-functions-list.md)
- [API Routes: Monitoring Endpoints](../../1.0-overview/1.4-api-routes-list.md)
- [AI System: Usage Tracking](../../2.0-architecture/2.6-features/ai-system.md)

---

**Last Updated:** 2025-09-29
**Maintained By:** PageSpace Core Team
**Agent Type:** general-purpose