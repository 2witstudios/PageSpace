# Audit Logging Architecture

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PageSpace Services                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                │
│  │   Web App    │   │   Realtime   │   │  Processor   │                │
│  │   (Next.js)  │   │  (Socket.IO) │   │  (Worker)    │                │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘                │
│         │                  │                  │                          │
│         │ API Routes       │ Socket Events    │ Background Jobs          │
│         │                  │                  │                          │
└─────────┼──────────────────┼──────────────────┼──────────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Audit Logger Middleware Layer                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐            │
│  │   withAudit()  │  │ withAuditAi()  │  │ withAuditJob() │            │
│  │                │  │                │  │                │            │
│  │ • Extracts     │  │ • Tracks tool  │  │ • Job start    │            │
│  │   context      │  │   execution    │  │ • Job end      │            │
│  │ • Captures     │  │ • Success/fail │  │ • Metadata     │            │
│  │   changes      │  │ • Metadata     │  │                │            │
│  └────────┬───────┘  └────────┬───────┘  └────────┬───────┘            │
│           │                   │                   │                      │
│           └───────────────────┴───────────────────┘                      │
│                               │                                          │
└───────────────────────────────┼──────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Core Audit Logger (Singleton)                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                    Batching & Buffering                       │       │
│  │  ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐  ...  ┌──────┐      │       │
│  │  │Entry │  │Entry │  │Entry │  │Entry │       │Entry │      │       │
│  │  │  1   │  │  2   │  │  3   │  │  4   │       │  50  │      │       │
│  │  └──────┘  └──────┘  └──────┘  └──────┘       └──────┘      │       │
│  │                                                               │       │
│  │  Flush Triggers:                                             │       │
│  │  • Buffer reaches 50 entries (configurable)                  │       │
│  │  • 10 seconds elapsed (configurable)                         │       │
│  │  • Process exit/shutdown                                     │       │
│  │  • Manual forceFlush() call                                  │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                Privacy & Sanitization Layer                   │       │
│  │  • Auto-redact sensitive fields (password, token, etc.)      │       │
│  │  • IP anonymization (192.168.1.xxx)                          │       │
│  │  • Email hashing (SHA-256)                                   │       │
│  │  • Metadata sanitization                                     │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
└───────────────────────────────┬───────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Database Writer with Retry Logic                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Attempt 1:  ──────────────► [Write to DB]                              │
│                                    │                                     │
│                              ┌─────┴──────┐                              │
│                              │            │                              │
│                          Success      Failure                            │
│                              │            │                              │
│                              ▼            ▼                              │
│                           [Done]    Wait 1s → Retry                      │
│                                           │                              │
│  Attempt 2:  ────────────────────────────┴──► [Write to DB]             │
│                                                      │                   │
│                                                 ┌────┴────┐              │
│                                                 │         │              │
│                                             Success   Failure            │
│                                                 │         │              │
│                                                 ▼         ▼              │
│                                              [Done]  Wait 2s → Retry     │
│                                                            │              │
│  Attempt 3:  ──────────────────────────────────────────────┴─► [...]    │
│                                                                           │
│  If all retries fail: Log to console (fallback)                          │
│                                                                           │
└───────────────────────────────┬───────────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      PostgreSQL Database                                 │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────┐       │
│  │                      audit_logs Table                         │       │
│  ├──────────────────────────────────────────────────────────────┤       │
│  │ id            │ cuid2                                         │       │
│  │ timestamp     │ 2024-11-15 13:45:23.123                      │       │
│  │ action        │ PAGE_UPDATED                                 │       │
│  │ category      │ page                                         │       │
│  │ user_id       │ user_abc123                                  │       │
│  │ resource_type │ page                                         │       │
│  │ resource_id   │ page_xyz789                                  │       │
│  │ changes       │ {"before": {...}, "after": {...}}           │       │
│  │ metadata      │ {"source": "web", "duration": 45}           │       │
│  │ success       │ true                                         │       │
│  │ anonymized    │ false                                        │       │
│  │ retention_date│ 2031-11-15 (7 years)                        │       │
│  └──────────────────────────────────────────────────────────────┘       │
│                                                                           │
│  Indexes: timestamp, action, user_id, resource_id, retention_date       │
│                                                                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## Data Flow

### 1. API Request Audit Flow

```
User Action (e.g., Update Page)
         │
         ▼
┌────────────────────┐
│  Next.js Handler   │
│  wrapped with      │
│  withAudit()       │
└────────┬───────────┘
         │
         ├─► Extract context (userId, IP, userAgent)
         │
         ├─► Execute actual handler
         │
         ├─► Capture result (success/error)
         │
         ▼
┌────────────────────┐
│  auditLogger.log() │ ◄── Fire-and-forget (async, non-blocking)
└────────┬───────────┘
         │
         ├─► Sanitize metadata
         │
         ├─► Anonymize IP (if enabled)
         │
         ├─► Hash email (if enabled)
         │
         ▼
┌────────────────────┐
│  Add to buffer     │
└────────┬───────────┘
         │
         ├─► Buffer size < 50? → Wait
         │
         ├─► Buffer size = 50? → Auto-flush
         │
         ▼
┌────────────────────┐
│  Batch write to DB │ ◄── Retry on failure (3 attempts)
└────────────────────┘
```

### 2. AI Tool Execution Audit Flow

```
AI Conversation Request
         │
         ▼
┌────────────────────┐
│  Tool execution    │
│  wrapped with      │
│  withAuditAiTool() │
└────────┬───────────┘
         │
         ├─► Execute tool logic
         │
         ├─► Capture result/error
         │
         ▼
┌────────────────────┐
│  auditLogger.log() │
│  action:           │
│  AI_TOOL_CALLED    │
└────────┬───────────┘
         │
         ▼
    [Same batching flow as above]
```

### 3. GDPR Data Anonymization Flow

```
User Deletion Request
         │
         ▼
┌────────────────────────────┐
│ anonymizeUserAuditLogs()   │
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Query all logs for user   │
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Generate anonymous hash   │
│  SHA-256(userId) → abc123  │
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Update audit_logs:        │
│  • user_id = 'anon_abc123' │
│  • user_email = 'anon@...' │
│  • ip = NULL               │
│  • user_agent = NULL       │
│  • metadata = NULL         │
│  • anonymized = TRUE       │
└────────┬───────────────────┘
         │
         ▼
    Audit trail preserved,
    PII removed
```

### 4. Retention Policy Cleanup Flow

```
Scheduled Job (Daily at 2 AM)
         │
         ▼
┌────────────────────────────┐
│ deleteExpiredAuditLogs()   │
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Query:                    │
│  WHERE retention_date < NOW│
│    AND anonymized = TRUE   │
└────────┬───────────────────┘
         │
         ▼
┌────────────────────────────┐
│  Delete expired logs       │
│  (only anonymized ones)    │
└────────┬───────────────────┘
         │
         ▼
    Compliance maintained,
    storage optimized
```

## Component Interaction

```
┌──────────────────────────────────────────────────────────────┐
│                     Application Layer                        │
│                                                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  API Routes │  │  AI Tools   │  │   Jobs      │         │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘         │
│         │                │                 │                 │
└─────────┼────────────────┼─────────────────┼─────────────────┘
          │                │                 │
          ▼                ▼                 ▼
┌──────────────────────────────────────────────────────────────┐
│                   Middleware Layer                           │
│  withAudit() │ withAuditAiTool() │ withAuditBackgroundJob() │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   Core Audit Logger                          │
│  • Batching    • Sanitization    • Retry Logic               │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   Database Writer                            │
│  • Format conversion    • Batch insert                       │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                   PostgreSQL                                 │
│  audit_logs table with 11 indexes                            │
└──────────────────────────────────────────────────────────────┘


┌──────────────────────────────────────────────────────────────┐
│                   GDPR Utilities (Parallel)                  │
│                                                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │  Anonymization  │  │  Data Export    │  │  Retention  │ │
│  │                 │  │                 │  │  Cleanup    │ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘ │
│           │                    │                   │         │
└───────────┼────────────────────┼───────────────────┼─────────┘
            │                    │                   │
            └────────────────────┴───────────────────┘
                                 │
                                 ▼
                        Direct DB access
                        (bypasses logger)
```

## Performance Characteristics

### Latency Impact

```
Without Audit Logging:
  API Request → Handler → Response
  ├─ Handler: 50ms
  └─ Total: 50ms

With Audit Logging:
  API Request → Handler → Response
  ├─ Handler: 50ms
  ├─ Audit log (buffer append): 0.5ms ◄── Non-blocking
  └─ Total: 50.5ms (1% overhead)

  Background (async):
  ├─ Buffer flush: 20-50ms (every 10s or 50 entries)
  └─ Database write: 5-15ms per batch
```

### Throughput Comparison

```
Without batching (hypothetical):
  1000 requests/min × 1ms DB write each = 1000ms/min DB time
  = Significant connection pool pressure

With batching (actual):
  1000 requests/min ÷ 50 entries/batch = 20 batches/min
  20 batches × 20ms each = 400ms/min DB time
  = 60% reduction in DB time
  = 50x fewer connections
```

### Memory Profile

```
┌─────────────────────────────────────┐
│       Audit Logger Memory           │
├─────────────────────────────────────┤
│ Buffer (50 entries × 2KB):   100KB │
│ Singleton overhead:            5KB │
│ Total:                       105KB │
└─────────────────────────────────────┘

Compare to typical Next.js app: 100-500MB
Audit logger: < 0.1% of app memory
```

## Security & Privacy Layers

```
┌──────────────────────────────────────────────────────────────┐
│                  Input (User Action)                         │
│  {                                                            │
│    userId: "user_123",                                       │
│    email: "john.doe@example.com",                            │
│    password: "secret123",                                    │
│    ip: "192.168.1.42",                                       │
│    metadata: { apiKey: "sk_live_abc..." }                    │
│  }                                                            │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│               Privacy Layer 1: Sanitization                  │
│  • Redacts: password, token, secret, apiKey                  │
│  • Recursive scan of all nested objects                      │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│             Privacy Layer 2: IP Anonymization                │
│  • IPv4: 192.168.1.42 → 192.168.1.xxx                       │
│  • IPv6: 2001:db8::1 → 2001:db8::xxxx                       │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│             Privacy Layer 3: Email Hashing                   │
│  • SHA-256(email) → "a3f2c1b..."                            │
│  • Allows correlation without exposing email                 │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                  Output (Stored in DB)                       │
│  {                                                            │
│    userId: "user_123",                                       │
│    email: "a3f2c1b4d5e6f7a8", // hashed                     │
│    password: "[REDACTED]",                                   │
│    ip: "192.168.1.xxx", // anonymized                        │
│    metadata: { apiKey: "[REDACTED]" }                        │
│  }                                                            │
└──────────────────────────────────────────────────────────────┘
```

## Deployment Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                        Production                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐   │
│  │  Web Instance  │  │  Web Instance  │  │  Web Instance  │   │
│  │  (Next.js)     │  │  (Next.js)     │  │  (Next.js)     │   │
│  │                │  │                │  │                │   │
│  │  Audit Logger  │  │  Audit Logger  │  │  Audit Logger  │   │
│  │  Buffer: 50    │  │  Buffer: 50    │  │  Buffer: 50    │   │
│  └───────┬────────┘  └───────┬────────┘  └───────┬────────┘   │
│          │                   │                   │             │
│          └───────────────────┴───────────────────┘             │
│                              │                                 │
└──────────────────────────────┼─────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                   PostgreSQL (Primary)                          │
│  • audit_logs table                                             │
│  • 11 indexes for query performance                             │
│  • Retention: 7 years default                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Monitoring Dashboard (Conceptual)

```
┌──────────────────────────────────────────────────────────────┐
│                  Audit Logging Dashboard                     │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Buffer Status:                                              │
│  ┌──────────────────────────────────────────┐               │
│  │ ████████████░░░░░░░░░░░░░░░░ 24/50       │ 48%           │
│  └──────────────────────────────────────────┘               │
│                                                               │
│  Write Performance (Last 1 hour):                            │
│  ┌──────────────────────────────────────────┐               │
│  │ Success: 1,234 batches (99.8%)           │               │
│  │ Failed:  2 batches (retried)             │               │
│  │ Average flush time: 23ms                 │               │
│  └──────────────────────────────────────────┘               │
│                                                               │
│  Top Actions:                                                │
│  ┌──────────────────────────────────────────┐               │
│  │ PAGE_UPDATED:      542 (44%)             │               │
│  │ AI_TOOL_CALLED:    231 (19%)             │               │
│  │ PAGE_CREATED:      189 (15%)             │               │
│  │ USER_LOGIN:        123 (10%)             │               │
│  └──────────────────────────────────────────┘               │
│                                                               │
│  GDPR Compliance:                                            │
│  ┌──────────────────────────────────────────┐               │
│  │ Total logs: 45,231                       │               │
│  │ Anonymized: 1,234 (2.7%)                 │               │
│  │ Expiring in 30 days: 23                  │               │
│  │ Last cleanup: 2024-11-15 02:00           │               │
│  └──────────────────────────────────────────┘               │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

## Error Handling Flow

```
Audit Log Request
         │
         ▼
    Try to log
         │
    ┌────┴────┐
    │         │
Success    Exception
    │         │
    ▼         ▼
 Buffer    Log error
  entry    to console
    │         │
    │         └──► Continue
    │              (never fail
    ▼               user op)
Batch flush
    │
    ┌─────┴─────┐
    │           │
Success     Failure
    │           │
    ▼           ▼
  Done      Retry #1
               │
          ┌────┴────┐
          │         │
      Success   Failure
          │         │
          ▼         ▼
        Done    Retry #2
                   │
              ┌────┴────┐
              │         │
          Success   Failure
              │         │
              ▼         ▼
            Done    Retry #3
                       │
                  ┌────┴────┐
                  │         │
              Success   Failure
                  │         │
                  ▼         ▼
                Done    Log to
                        console
                        (fallback)
```

This architecture ensures that audit logging never impacts user experience while maintaining comprehensive compliance and security tracking.
