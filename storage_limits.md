# PageSpace Storage Limits Implementation Plan

## Executive Summary

This document outlines a comprehensive storage management system for PageSpace, implementing user storage quotas, file size limits, and preparing for future scaling. The plan is divided into three phases, with Phase 1 providing immediate basic functionality, Phase 2 adding performance optimizations, and Phase 3 introducing enterprise features.

**Current State**: No storage limits, 100MB hardcoded file size limit, files loaded entirely into memory
**Target State**: 1GB user quotas, scalable architecture, cloud storage ready

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Phase 1: Basic Storage Limits (Immediate)](#phase-1-basic-storage-limits-immediate)
3. [Phase 2: Performance & Scaling (3-6 months)](#phase-2-performance--scaling-3-6-months)
4. [Phase 3: Enterprise Features (6-12 months)](#phase-3-enterprise-features-6-12-months)
5. [Technical Considerations](#technical-considerations)
6. [Security Requirements](#security-requirements)
7. [Migration Strategy](#migration-strategy)

## Current State Analysis

### Existing Implementation
- **Upload Route**: `/apps/web/src/app/api/upload/route.ts`
  - 100MB hardcoded file size limit
  - Files loaded entirely into memory via `ArrayBuffer`
  - No chunking support
  - Basic file metadata tracking

### Database Schema
- **Pages Table**: Tracks individual file sizes in `fileSize` field
- **Users Table**: No storage quota or usage tracking
- **Missing**: User storage limits, usage tracking, storage events

### Performance Concerns
- **Memory Usage**: 200-400MB RAM per 100MB file (encoding overhead)
- **Concurrent Uploads**: System breaks at ~10 concurrent 100MB uploads
- **No Streaming**: Entire file loaded into memory before processing

### Security Issues
- **Race Conditions**: No locking for concurrent storage operations
- **TOCTOU Vulnerabilities**: Time-of-check to time-of-use gaps
- **Missing Validation**: Insufficient server-side quota checks

## Phase 1: Basic Storage Limits (Immediate)

### 1.1 Database Schema Changes

#### Add Storage Fields to Users Table
```sql
-- Migration: add_user_storage_fields
ALTER TABLE users 
ADD COLUMN storage_quota_bytes BIGINT DEFAULT 1073741824, -- 1GB default
ADD COLUMN storage_used_bytes BIGINT DEFAULT 0,
ADD COLUMN storage_tier TEXT DEFAULT 'free' CHECK (storage_tier IN ('free', 'pro', 'enterprise')),
ADD COLUMN last_storage_calculated TIMESTAMP DEFAULT NOW();

-- Add indexes for performance
CREATE INDEX users_storage_tier_idx ON users(storage_tier);
CREATE INDEX users_storage_used_idx ON users(storage_used_bytes);
```

#### Create Storage Events Table
```sql
-- Migration: create_storage_events
CREATE TABLE storage_events (
  id TEXT PRIMARY KEY DEFAULT create_id(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  drive_id TEXT REFERENCES drives(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('upload', 'delete', 'update', 'reconcile')),
  size_delta BIGINT NOT NULL,
  total_size_after BIGINT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  created_by TEXT REFERENCES users(id)
);

-- Indexes for querying
CREATE INDEX storage_events_user_id_idx ON storage_events(user_id);
CREATE INDEX storage_events_created_at_idx ON storage_events(created_at DESC);
CREATE INDEX storage_events_event_type_idx ON storage_events(event_type);
```

### 1.2 Storage Utilities Implementation

#### `/packages/lib/src/storage-utils.ts`
```typescript
import { db, users, pages, drives, eq, sql, and } from '@pagespace/db';

export interface StorageQuota {
  userId: string;
  quotaBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilizationPercent: number;
  tier: 'free' | 'pro' | 'enterprise';
  warningLevel: 'none' | 'warning' | 'critical';
}

export interface StorageCheckResult {
  allowed: boolean;
  reason?: string;
  quota?: StorageQuota;
  requiredBytes?: number;
}

export const STORAGE_TIERS = {
  free: {
    name: 'Free',
    quotaBytes: 1 * 1024 * 1024 * 1024, // 1GB
    maxFileSize: 100 * 1024 * 1024, // 100MB
    maxFiles: 1000,
    features: ['Basic storage', '1GB total', '100MB per file']
  },
  pro: {
    name: 'Pro',
    quotaBytes: 100 * 1024 * 1024 * 1024, // 100GB
    maxFileSize: 1 * 1024 * 1024 * 1024, // 1GB
    maxFiles: 10000,
    features: ['Advanced storage', '100GB total', '1GB per file', 'Priority support']
  },
  enterprise: {
    name: 'Enterprise',
    quotaBytes: 1 * 1024 * 1024 * 1024 * 1024, // 1TB
    maxFileSize: 5 * 1024 * 1024 * 1024, // 5GB
    maxFiles: 100000,
    features: ['Enterprise storage', '1TB total', '5GB per file', 'Dedicated support']
  }
} as const;

/**
 * Get user's current storage quota and usage
 * Uses database-stored values for performance
 */
export async function getUserStorageQuota(userId: string): Promise<StorageQuota | null> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      id: true,
      storageQuotaBytes: true,
      storageUsedBytes: true,
      storageTier: true
    }
  });

  if (!user) return null;

  const tier = (user.storageTier || 'free') as keyof typeof STORAGE_TIERS;
  const quotaBytes = user.storageQuotaBytes || STORAGE_TIERS[tier].quotaBytes;
  const usedBytes = user.storageUsedBytes || 0;
  const availableBytes = Math.max(0, quotaBytes - usedBytes);
  const utilizationPercent = quotaBytes > 0 ? (usedBytes / quotaBytes) * 100 : 0;

  return {
    userId: user.id,
    quotaBytes,
    usedBytes,
    availableBytes,
    utilizationPercent,
    tier,
    warningLevel: getWarningLevel(utilizationPercent)
  };
}

/**
 * Check if user can upload a file of given size
 * This is the main validation function for uploads
 */
export async function checkStorageQuota(
  userId: string,
  fileSize: number
): Promise<StorageCheckResult> {
  // Get user's current quota
  const quota = await getUserStorageQuota(userId);
  
  if (!quota) {
    return {
      allowed: false,
      reason: 'User not found'
    };
  }

  // Check tier file size limit
  const tierConfig = STORAGE_TIERS[quota.tier];
  if (fileSize > tierConfig.maxFileSize) {
    return {
      allowed: false,
      reason: `File exceeds ${quota.tier} tier limit of ${formatBytes(tierConfig.maxFileSize)}`,
      quota,
      requiredBytes: fileSize
    };
  }

  // Check available storage
  if (fileSize > quota.availableBytes) {
    return {
      allowed: false,
      reason: `Insufficient storage: need ${formatBytes(fileSize)}, have ${formatBytes(quota.availableBytes)} available`,
      quota,
      requiredBytes: fileSize
    };
  }

  return {
    allowed: true,
    quota
  };
}

/**
 * Update user's storage usage atomically
 * Uses database transaction to prevent race conditions
 */
export async function updateStorageUsage(
  userId: string,
  deltaBytes: number,
  context?: {
    pageId?: string;
    driveId?: string;
    eventType?: 'upload' | 'delete' | 'update';
  }
): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock user row and update storage
    const [updatedUser] = await tx
      .update(users)
      .set({
        storageUsedBytes: sql`GREATEST(0, COALESCE(storage_used_bytes, 0) + ${deltaBytes})`,
        lastStorageCalculated: new Date()
      })
      .where(eq(users.id, userId))
      .returning({
        newUsage: users.storageUsedBytes
      });

    // Log storage event for audit trail
    if (context) {
      await tx.insert(storageEvents).values({
        userId,
        driveId: context.driveId,
        pageId: context.pageId,
        eventType: context.eventType || 'update',
        sizeDelta: deltaBytes,
        totalSizeAfter: updatedUser.newUsage || 0,
        createdBy: userId
      });
    }
  });
}

/**
 * Calculate actual storage usage from database
 * Used for reconciliation and verification
 */
export async function calculateActualStorageUsage(userId: string): Promise<number> {
  const result = await db
    .select({
      totalSize: sql<number>`COALESCE(SUM(${pages.fileSize}), 0)`
    })
    .from(pages)
    .innerJoin(drives, eq(pages.driveId, drives.id))
    .where(and(
      eq(drives.ownerId, userId),
      eq(pages.isTrashed, false)
    ));

  return Number(result[0]?.totalSize || 0);
}

/**
 * Reconcile stored usage with actual usage
 * Should be run periodically to fix any drift
 */
export async function reconcileStorageUsage(userId: string): Promise<{
  previousUsage: number;
  actualUsage: number;
  difference: number;
}> {
  const quota = await getUserStorageQuota(userId);
  const actualUsage = await calculateActualStorageUsage(userId);
  
  if (!quota) {
    throw new Error('User not found');
  }

  const difference = actualUsage - quota.usedBytes;

  // Update if there's a discrepancy
  if (difference !== 0) {
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          storageUsedBytes: actualUsage,
          lastStorageCalculated: new Date()
        })
        .where(eq(users.id, userId));

      await tx.insert(storageEvents).values({
        userId,
        eventType: 'reconcile',
        sizeDelta: difference,
        totalSizeAfter: actualUsage,
        metadata: {
          previousUsage: quota.usedBytes,
          actualUsage,
          difference
        }
      });
    });
  }

  return {
    previousUsage: quota.usedBytes,
    actualUsage,
    difference
  };
}

/**
 * Get storage warning level based on usage percentage
 */
function getWarningLevel(percent: number): 'none' | 'warning' | 'critical' {
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'warning';
  return 'none';
}

/**
 * Format bytes to human-readable string
 */
export function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
}

/**
 * Parse human-readable size to bytes
 */
export function parseBytes(size: string): number {
  const units: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024
  };
  
  const match = size.match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B)$/i);
  if (!match) throw new Error('Invalid size format');
  
  const [, value, unit] = match;
  return Math.floor(parseFloat(value) * (units[unit.toUpperCase()] || 1));
}
```

### 1.3 API Endpoints

#### Pre-Upload Validation: `/apps/web/src/app/api/storage/check/route.ts`
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { checkStorageQuota } from '@pagespace/lib/storage-utils';

export async function POST(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { fileSize } = await request.json();
    
    if (!fileSize || fileSize <= 0) {
      return NextResponse.json({ error: 'Invalid file size' }, { status: 400 });
    }

    const result = await checkStorageQuota(user.id, fileSize);
    
    return NextResponse.json(result, {
      status: result.allowed ? 200 : 413
    });
  } catch (error) {
    console.error('Storage check error:', error);
    return NextResponse.json(
      { error: 'Failed to check storage quota' },
      { status: 500 }
    );
  }
}
```

#### Storage Info: `/apps/web/src/app/api/storage/info/route.ts`
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getUserStorageQuota } from '@pagespace/lib/storage-utils';

export async function GET(request: NextRequest) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const quota = await getUserStorageQuota(user.id);
    
    if (!quota) {
      return NextResponse.json({ error: 'Storage info not found' }, { status: 404 });
    }

    return NextResponse.json(quota);
  } catch (error) {
    console.error('Storage info error:', error);
    return NextResponse.json(
      { error: 'Failed to get storage info' },
      { status: 500 }
    );
  }
}
```

### 1.4 Upload Route Updates

Update `/apps/web/src/app/api/upload/route.ts`:
```typescript
// Add imports
import { checkStorageQuota, updateStorageUsage } from '@pagespace/lib/storage-utils';

// In POST handler, after auth verification:
// Check storage quota before processing
const quotaCheck = await checkStorageQuota(user.id, file.size);
if (!quotaCheck.allowed) {
  return NextResponse.json({
    error: quotaCheck.reason,
    storageInfo: quotaCheck.quota
  }, { status: 413 });
}

// After successful file save, update storage usage in transaction:
await db.transaction(async (tx) => {
  const [newPage] = await tx.insert(pages).values({
    // ... existing page values
  }).returning();

  // Update storage usage atomically
  await updateStorageUsage(user.id, file.size, {
    pageId: newPage.id,
    driveId,
    eventType: 'upload'
  });

  return newPage;
});
```

### 1.5 Client-Side Updates

#### Update `/apps/web/src/hooks/useFileDrop.ts`:
```typescript
// Add pre-upload validation
const validateFileSize = async (fileSize: number): Promise<boolean> => {
  try {
    const response = await fetch('/api/storage/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileSize })
    });

    if (!response.ok) {
      const data = await response.json();
      toast.error(data.reason || 'File exceeds storage limit');
      return false;
    }

    return true;
  } catch (error) {
    console.error('Storage validation error:', error);
    return false;
  }
};

// In handleFileDrop, before upload:
for (const file of files) {
  if (!await validateFileSize(file.size)) {
    continue; // Skip this file
  }
  // ... proceed with upload
}
```

## Phase 2: Performance & Scaling (3-6 months)

### 2.1 Chunked Upload Implementation

#### Stream-Based Upload Processing
```typescript
// New chunked upload endpoint: /api/upload/chunked
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

export async function POST(request: NextRequest) {
  const searchParams = new URL(request.url).searchParams;
  const chunkIndex = parseInt(searchParams.get('chunk') || '0');
  const totalChunks = parseInt(searchParams.get('total') || '1');
  const uploadId = searchParams.get('uploadId');

  // Process chunk using streams
  const stream = request.body;
  if (!stream) throw new Error('No body stream');

  const tempPath = join(TEMP_DIR, uploadId, `chunk-${chunkIndex}`);
  await pipeline(
    stream,
    createWriteStream(tempPath)
  );

  // If all chunks received, combine them
  if (chunkIndex === totalChunks - 1) {
    await combineChunks(uploadId, totalChunks);
  }

  return NextResponse.json({ 
    success: true, 
    chunk: chunkIndex,
    progress: ((chunkIndex + 1) / totalChunks) * 100
  });
}
```

### 2.2 Real-time Progress Tracking

#### Using AI SDK's createStreamableValue
```typescript
import { createStreamableValue } from 'ai/rsc';

export async function uploadWithProgress(file: File) {
  const progress = createStreamableValue(0);

  // Upload logic with progress updates
  const chunkSize = 1024 * 1024; // 1MB chunks
  const totalChunks = Math.ceil(file.size / chunkSize);

  for (let i = 0; i < totalChunks; i++) {
    const chunk = file.slice(i * chunkSize, (i + 1) * chunkSize);
    await uploadChunk(chunk, i, totalChunks);
    progress.update((i + 1) / totalChunks * 100);
  }

  progress.done();
  return progress.value;
}
```

### 2.3 Storage Tiers Implementation

```typescript
// Tier upgrade/downgrade logic
export async function changeUserTier(
  userId: string,
  newTier: 'free' | 'pro' | 'enterprise'
): Promise<void> {
  const currentQuota = await getUserStorageQuota(userId);
  const newQuotaBytes = STORAGE_TIERS[newTier].quotaBytes;

  // Check if current usage fits in new tier
  if (currentQuota && currentQuota.usedBytes > newQuotaBytes) {
    throw new Error(`Current usage (${formatBytes(currentQuota.usedBytes)}) exceeds ${newTier} tier limit`);
  }

  await db.update(users)
    .set({
      storageTier: newTier,
      storageQuotaBytes: newQuotaBytes
    })
    .where(eq(users.id, userId));
}
```

### 2.4 Performance Optimizations

#### Caching Layer
```typescript
import { LRUCache } from 'lru-cache';

const storageCache = new LRUCache<string, StorageQuota>({
  max: 1000,
  ttl: 1000 * 60 * 5 // 5 minutes
});

export async function getCachedStorageQuota(userId: string): Promise<StorageQuota | null> {
  const cached = storageCache.get(userId);
  if (cached) return cached;

  const quota = await getUserStorageQuota(userId);
  if (quota) {
    storageCache.set(userId, quota);
  }
  return quota;
}

// Invalidate cache on updates
export async function invalidateStorageCache(userId: string): Promise<void> {
  storageCache.delete(userId);
}
```

## Phase 3: Enterprise Features (6-12 months)

### 3.1 Cloud Storage Integration

#### AWS S3 Integration
```typescript
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
  }
});

export async function uploadToS3(
  file: Buffer,
  key: string,
  metadata: Record<string, string>
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    Body: file,
    Metadata: metadata
  });

  await s3Client.send(command);
  return `s3://${process.env.S3_BUCKET}/${key}`;
}

// Generate presigned URL for direct browser upload
export async function getPresignedUploadUrl(
  key: string,
  contentType: string,
  maxSize: number
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    ContentType: contentType,
    ContentLength: maxSize
  });

  return getSignedUrl(s3Client, command, { expiresIn: 3600 });
}
```

### 3.2 Advanced Storage Analytics

```typescript
export interface StorageAnalytics {
  userId: string;
  period: 'day' | 'week' | 'month' | 'year';
  totalUploaded: number;
  totalDeleted: number;
  netChange: number;
  fileTypeBreakdown: Record<string, number>;
  largestFiles: Array<{
    id: string;
    name: string;
    size: number;
  }>;
  uploadTrends: Array<{
    date: string;
    uploads: number;
    totalSize: number;
  }>;
}

export async function getStorageAnalytics(
  userId: string,
  period: StorageAnalytics['period'] = 'month'
): Promise<StorageAnalytics> {
  const startDate = getStartDate(period);

  // Get upload/delete events
  const events = await db.query.storageEvents.findMany({
    where: and(
      eq(storageEvents.userId, userId),
      gte(storageEvents.createdAt, startDate)
    ),
    orderBy: (events, { desc }) => [desc(events.createdAt)]
  });

  // Calculate analytics
  const analytics = processStorageEvents(events);
  
  return analytics;
}
```

### 3.3 Team Storage Management

```typescript
// Team/drive-level storage quotas
export interface TeamStorageQuota {
  driveId: string;
  teamQuotaBytes: number;
  teamUsedBytes: number;
  memberQuotas: Map<string, number>;
}

export async function getTeamStorageQuota(driveId: string): Promise<TeamStorageQuota> {
  // Get drive and all members
  const drive = await db.query.drives.findFirst({
    where: eq(drives.id, driveId),
    with: {
      members: true,
      pages: {
        where: eq(pages.type, 'FILE')
      }
    }
  });

  // Calculate team usage
  const teamUsedBytes = drive.pages.reduce((sum, page) => sum + (page.fileSize || 0), 0);
  
  // Get individual member quotas
  const memberQuotas = new Map();
  for (const member of drive.members) {
    const quota = await getUserStorageQuota(member.userId);
    if (quota) {
      memberQuotas.set(member.userId, quota.usedBytes);
    }
  }

  return {
    driveId,
    teamQuotaBytes: calculateTeamQuota(drive),
    teamUsedBytes,
    memberQuotas
  };
}
```

### 3.4 AI-Powered Storage Optimization

```typescript
import { generateObject } from 'ai';

export async function getStorageRecommendations(userId: string) {
  const analytics = await getStorageAnalytics(userId, 'month');
  
  const recommendations = await generateObject({
    model: openai('gpt-4'),
    schema: z.object({
      duplicates: z.array(z.object({
        files: z.array(z.string()),
        potentialSavings: z.number()
      })),
      compressionCandidates: z.array(z.object({
        fileId: z.string(),
        currentSize: z.number(),
        estimatedCompressed: z.number()
      })),
      unusedFiles: z.array(z.object({
        fileId: z.string(),
        lastAccessed: z.string(),
        size: z.number()
      })),
      upgradeSuggestion: z.boolean(),
      estimatedMonthlySavings: z.number()
    }),
    prompt: `Analyze storage usage and provide optimization recommendations: ${JSON.stringify(analytics)}`
  });

  return recommendations.object;
}
```

## Technical Considerations

### Memory Management
- **Current Issue**: Loading 100MB files into memory causes 200-400MB RAM usage
- **Phase 1 Solution**: Keep current approach but add concurrent upload limits
- **Phase 2 Solution**: Implement streaming for files >50MB
- **Phase 3 Solution**: Direct-to-cloud uploads bypassing server memory

### Database Performance
- **Indexes**: Add indexes on storage fields for fast lookups
- **Transactions**: Use row-level locks to prevent race conditions
- **Reconciliation**: Run periodic jobs to fix storage drift

### Concurrent Upload Handling
```typescript
// Semaphore to limit concurrent uploads
class UploadSemaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(maxConcurrent: number = 5) {
    this.permits = maxConcurrent;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    await new Promise<void>(resolve => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    this.permits++;
    const next = this.waiting.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
}

const uploadSemaphore = new UploadSemaphore(5);

// In upload handler:
await uploadSemaphore.acquire();
try {
  // Process upload
} finally {
  uploadSemaphore.release();
}
```

## Security Requirements

### 1. Race Condition Prevention
- Use database transactions with row locks
- Atomic check-and-update operations
- Proper isolation levels

### 2. Input Validation
- Server-side file size validation
- MIME type verification
- Path traversal prevention
- File name sanitization

### 3. Authentication & Authorization
- Verify user authentication before storage operations
- Check drive permissions for uploads
- Validate user owns files being deleted

### 4. Rate Limiting
```typescript
import { RateLimiter } from 'limiter';

const uploadLimiter = new RateLimiter({
  tokensPerInterval: 10,
  interval: 'minute',
  fireImmediately: true
});

// In upload handler:
if (!await uploadLimiter.tryRemoveTokens(1)) {
  return NextResponse.json(
    { error: 'Rate limit exceeded' },
    { status: 429 }
  );
}
```

## Migration Strategy

### Phase 1 Migration Steps

1. **Add Database Columns**
```sql
-- Run migration to add storage fields
pnpm db:generate
pnpm db:migrate
```

2. **Calculate Existing Usage**
```typescript
// One-time script to calculate current usage
async function migrateExistingStorage() {
  const allUsers = await db.query.users.findMany();
  
  for (const user of allUsers) {
    const usage = await calculateActualStorageUsage(user.id);
    await db.update(users)
      .set({
        storageUsedBytes: usage,
        storageQuotaBytes: STORAGE_TIERS.free.quotaBytes,
        storageTier: 'free'
      })
      .where(eq(users.id, user.id));
  }
}
```

3. **Deploy with Feature Flags**
```typescript
const FEATURES = {
  storageQuotas: process.env.ENABLE_STORAGE_QUOTAS === 'true',
  chunkedUploads: process.env.ENABLE_CHUNKED_UPLOADS === 'true',
  cloudStorage: process.env.ENABLE_CLOUD_STORAGE === 'true'
};

// Use feature flags in code
if (FEATURES.storageQuotas) {
  const quotaCheck = await checkStorageQuota(user.id, file.size);
  if (!quotaCheck.allowed) {
    return NextResponse.json({ error: quotaCheck.reason }, { status: 413 });
  }
}
```

### Rollback Plan

1. **Database Rollback**
```sql
-- Rollback migration if needed
ALTER TABLE users 
DROP COLUMN storage_quota_bytes,
DROP COLUMN storage_used_bytes,
DROP COLUMN storage_tier,
DROP COLUMN last_storage_calculated;

DROP TABLE storage_events;
```

2. **Code Rollback**
- Remove storage check calls from upload route
- Remove storage utility imports
- Disable feature flags

## Monitoring & Observability

### Key Metrics to Track
- Upload success/failure rates
- Average upload size and duration
- Storage quota violations
- Memory usage during uploads
- Database query performance

### Logging Strategy
```typescript
// Structured logging for storage operations
logger.info('storage.upload', {
  userId,
  fileSize,
  mimeType,
  duration: Date.now() - startTime,
  success: true,
  quotaRemaining: quota.availableBytes
});

logger.error('storage.quota.exceeded', {
  userId,
  attempted: fileSize,
  available: quota.availableBytes,
  tier: quota.tier
});
```

### Alerting Rules
- Alert when user reaches 80% of quota
- Alert on high memory usage (>80% of available)
- Alert on storage reconciliation discrepancies >10%
- Alert on upload failure rate >5%

## Testing Requirements

### Unit Tests
```typescript
describe('Storage Utils', () => {
  test('checkStorageQuota prevents exceeding limit', async () => {
    const result = await checkStorageQuota(userId, 2 * GB);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds');
  });

  test('updateStorageUsage is atomic', async () => {
    // Test concurrent updates don't cause race conditions
    const updates = Array(10).fill(0).map(() => 
      updateStorageUsage(userId, 10 * MB)
    );
    await Promise.all(updates);
    
    const quota = await getUserStorageQuota(userId);
    expect(quota.usedBytes).toBe(100 * MB);
  });
});
```

### Integration Tests
- Test full upload flow with quota checks
- Test concurrent uploads from same user
- Test storage reconciliation accuracy
- Test tier upgrade/downgrade scenarios

### Load Tests
```typescript
// Using k6 for load testing
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 100 }, // Ramp up
    { duration: '5m', target: 100 }, // Stay at 100 users
    { duration: '2m', target: 0 },   // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<3000'], // 95% of requests under 3s
    http_req_failed: ['rate<0.05'],    // Error rate under 5%
  },
};

export default function() {
  const file = generateTestFile(10 * MB);
  const response = http.post('/api/upload', file);
  
  check(response, {
    'upload successful': (r) => r.status === 200,
    'quota info returned': (r) => r.json('storageInfo') !== null,
  });
}
```

## Success Criteria

### Phase 1 Success Metrics
- ✅ No memory exhaustion with 10 concurrent 100MB uploads
- ✅ Storage tracking accuracy within 1% of actual usage
- ✅ Zero security vulnerabilities in storage operations
- ✅ Upload success rate >95%
- ✅ User storage quota violations properly blocked

### Phase 2 Success Metrics
- ✅ Support for 1GB file uploads without memory issues
- ✅ Real-time progress tracking accuracy >90%
- ✅ Storage tier management without data loss
- ✅ <500ms response time for storage checks

### Phase 3 Success Metrics
- ✅ Cloud storage integration with <5s upload time for 1GB files
- ✅ Storage analytics dashboard with <2s load time
- ✅ AI recommendations reduce storage usage by >20%
- ✅ Team storage management with proper isolation

## Risk Analysis & Mitigation

### Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Memory exhaustion | High | Medium | Implement upload semaphore, streaming for large files |
| Storage drift | Medium | Low | Periodic reconciliation, transaction consistency |
| Race conditions | High | Medium | Database locks, atomic operations |
| Data loss | Critical | Low | Backups, transaction rollback, audit trail |

### Business Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| User frustration with limits | Medium | High | Clear UI feedback, upgrade prompts |
| Migration failures | High | Low | Feature flags, rollback plan |
| Performance degradation | High | Medium | Caching, query optimization |
| Cost overruns (Phase 3) | Medium | Medium | Usage monitoring, tier limits |

## Conclusion

This comprehensive plan provides a roadmap for implementing robust storage limits in PageSpace, starting with essential features in Phase 1 and progressively adding advanced capabilities. The phased approach ensures immediate value while maintaining flexibility for future scaling.

### Key Takeaways
1. **Phase 1 is MVP**: Basic quotas, validation, and tracking
2. **Phase 2 adds performance**: Streaming, chunking, real-time updates
3. **Phase 3 enables enterprise**: Cloud storage, analytics, AI optimization
4. **Security is critical**: Prevent race conditions, validate everything
5. **Monitor everything**: Metrics, logs, and alerts from day one

### Next Steps for Phase 1 Implementation
1. Create database migrations
2. Implement storage utilities
3. Update upload route with quota checks
4. Add pre-upload validation
5. Create basic storage UI component
6. Deploy with feature flags
7. Monitor and iterate

The implementation should start with Phase 1, which provides immediate value with minimal complexity, then progressively add features based on user needs and system growth.