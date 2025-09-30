# Processor Unified Queue Implementation Plan

## Core Principle
**One job type, one queue, one processor** - stop the madness of competing systems.

## The Single Job Model
```typescript
interface IngestFileJob {
  pageId: string;          // DB record to update
  contentHash: string;     // File identifier
  mimeType: string;        // Determines processing type
  originalName: string;    // For logging
  priority: 'high' | 'normal' | 'low';
  traceId: string;         // Request correlation
}
```

## Architecture Decision: Processor Updates DB Directly
**Why**: Least moving parts, already has all context, eliminates web/processor sync issues.

## Implementation Steps

### Step 1: Add DB Access to Processor
**File**: `apps/processor/src/workers/text-extractor.ts`
```typescript
import { db, pages, eq } from '@pagespace/db';

export async function extractText(data: IngestFileJob): Promise<any> {
  // ... existing extraction logic ...

  // UPDATE DB DIRECTLY
  await db.update(pages)
    .set({
      content: extractedText,
      processingStatus: extractedText ? 'completed' : 'visual',
      extractionMethod: 'text',
      extractionMetadata: metadata,
      contentHash: data.contentHash,
      processedAt: new Date()
    })
    .where(eq(pages.id, data.pageId));

  return { success: true, textLength: extractedText.length };
}
```

### Step 2: Replace Three Queues with One
**File**: `apps/processor/src/workers/queue-manager.ts`
```typescript
// DELETE: 'image-optimize', 'text-extract', 'ocr-process'
// ADD: Single 'ingest-file' queue

await this.boss.work('ingest-file',
  { teamSize: 5, teamConcurrency: 2 },  // Process up to 5 jobs, 2 at a time
  async (job) => {
    const { mimeType, contentHash, pageId } = job.data;

    // Route based on file type
    if (mimeType.startsWith('image/')) {
      await processImage(job.data);
      await db.update(pages)
        .set({ processingStatus: 'visual', processedAt: new Date() })
        .where(eq(pages.id, pageId));
    } else if (needsTextExtraction(mimeType)) {
      await extractText(job.data);  // This updates DB internally
    }

    return { success: true };
  }
);
```

### Step 3: Fix Upload Flow
**File**: `apps/processor/src/api/upload.ts`
```typescript
// After saving file...
const jobId = await this.boss.send('ingest-file', {
  pageId,
  contentHash,
  mimeType,
  originalName,
  priority: size < 5_000_000 ? 'high' : 'normal',
  traceId: req.headers['x-trace-id'] || createId()
}, {
  singletonKey: `ingest-${contentHash}`,  // Prevent duplicate processing
  retryLimit: 3,
  retryDelay: 60
});
```

**File**: `apps/web/src/app/api/upload/route.ts`
```typescript
// REMOVE ALL OF THIS:
// - getProducerQueue import
// - enqueueFileProcessing calls
// - Job queue logic (lines 254-289)

// Just let processor handle it via its response
const processorResult = await processorResponse.json();
// Processor now owns the entire flow
```

### Step 4: Handle Processing Status
```typescript
// Processing states per file type:
const PROCESSING_RULES = {
  'application/pdf': {
    hasText: 'completed',    // PDF with extractable text
    noText: 'visual',        // Scanned PDF, needs OCR
    failed: 'failed'
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    hasText: 'completed',
    noText: 'visual',        // Rare but possible
    failed: 'failed'
  },
  'image/*': {
    default: 'visual',       // Always visual unless OCR enabled
    withOCR: 'completed',    // If OCR finds text
    failed: 'visual'         // Fallback to visual on failure
  }
};
```

### Step 5: Remove Worker Service Entirely
**Files to DELETE**:
1. `apps/web/src/workers/file-processor.ts`
2. `apps/web/Dockerfile.worker`
3. `packages/lib/src/file-processor.ts`
4. `packages/lib/src/job-queue.ts`

**docker-compose.yml**: Remove entire worker service block

### Step 6: Add Observability
**File**: `apps/processor/src/api/status.ts`
```typescript
router.get('/api/queue/status', async (req, res) => {
  const stats = await boss.getQueueSize('ingest-file');
  const failed = await boss.getQueueSize('ingest-file', 'failed');
  res.json({
    pending: stats,
    failed,
    healthy: stats < 1000  // Alert if backlog grows
  });
});

router.get('/api/job/:id', async (req, res) => {
  const job = await boss.getJobById(req.params.id);
  res.json({
    id: job.id,
    status: job.state,
    data: job.data,
    output: job.output,
    retryCount: job.retrycount
  });
});
```

## Success Criteria
1. **PDF files process successfully** and text appears in DB
2. **DOCX files process successfully** and text appears in DB
3. **Images marked as 'visual'** and AI can read them
4. **Single queue** ('ingest-file') handles everything
5. **Worker service deleted** from codebase
6. **Processor updates DB directly** - no sync issues

## What NOT to Do
- Don't create new queue types
- Don't add webhooks/events (unnecessary complexity)
- Don't keep worker "for backup"
- Don't have web app process anything
- Don't use in-memory queues

## Testing Commands
```bash
# Upload PDF
curl -X POST http://localhost:3000/api/upload \
  -F "file=@test.pdf" -F "driveId=123"

# Check queue
curl http://localhost:3003/api/queue/status

# Check job
curl http://localhost:3003/api/job/{jobId}

# Verify DB
psql -c "SELECT id, processingStatus, content FROM pages WHERE type='FILE'"
```