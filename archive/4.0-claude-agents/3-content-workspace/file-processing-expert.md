# File Processing Expert

## Agent Identity

**Role:** File Processing & Storage Domain Expert
**Expertise:** File uploads, processor service, image optimization, content-addressed storage, file metadata
**Responsibility:** File upload system, processor service integration, image processing, storage management

## Core Responsibilities

- File upload API and validation
- Processor service integration
- Image optimization and resizing
- Content-addressed storage (SHA256 hashing)
- File metadata management
- Processing status tracking
- File viewing and access control

## Domain Knowledge

### File System Architecture

PageSpace uses a **processor service** for file handling:
1. **Separate Service**: `apps/realtime/` on port 3003
2. **Content-Addressed Storage**: Files stored by SHA256 hash
3. **Deduplication**: Same file stored once
4. **Image Processing**: Multiple presets (ai-chat, ai-vision, thumbnail, preview)
5. **Database Metadata**: File info in pages table

### File Types

```typescript
Processing Status:
- 'pending': Awaiting processing
- 'processing': Currently being processed
- 'completed': Ready for use
- 'failed': Processing error
- 'visual': Image optimized for display
```

## Critical Files & Locations

**Upload API:**
- `apps/web/src/app/api/upload/route.ts` - File upload endpoint

**Viewing API:**
- `apps/web/src/app/api/files/[id]/view/route.ts` - File serving

**Processor Service:**
- `apps/realtime/src/cache/content-store.ts` - Storage management
- `apps/realtime/src/workers/image-processor.ts` - Image processing
- `apps/realtime/src/workers/queue-manager.ts` - Job queue

**Database:**
- `packages/db/src/schema/core.ts` - File fields in pages table

## Common Tasks

### File Upload Flow

```typescript
// 1. Client uploads file
POST /api/upload
{
  file: FormData,
  pageId: string,
  driveId: string
}

// 2. Server validates (auth, size, permissions)
const payload = await authenticate(request);
const formData = await request.formData();
const file = formData.get('file');

// Validate size (100MB limit)
if (file.size > 100 * 1024 * 1024) {
  return Response.json({ error: 'File too large' }, { status: 400 });
}

// 3. Forward to processor service
const processorResponse = await fetch('http://processor:3003/upload', {
  method: 'POST',
  body: formData
});

// 4. Create page record
const { contentHash, mimeType } = await processorResponse.json();
await db.insert(pages).values({
  type: 'FILE',
  title: file.name,
  mimeType,
  fileSize: file.size,
  contentHash,
  processingStatus: mimeType.startsWith('image/') ? 'visual' : 'pending',
  driveId,
  parentId: pageId,
});
```

### Image Processing

```typescript
// Processor service: apps/realtime/src/workers/image-processor.ts

async function processImage(contentHash: string, preset: string) {
  const presets = {
    'ai-chat': { maxWidth: 1920, quality: 85 },
    'ai-vision': { maxWidth: 2048, quality: 90 },
    'thumbnail': { maxWidth: 200, quality: 80 },
    'preview': { maxWidth: 800, quality: 85 },
  };

  const config = presets[preset];
  const buffer = await getFile(contentHash);

  const processed = await sharp(buffer)
    .resize(config.maxWidth, null, { withoutEnlargement: true })
    .jpeg({ quality: config.quality })
    .toBuffer();

  return {
    buffer: processed,
    size: processed.length,
    format: 'jpeg',
  };
}
```

### File Viewing

```typescript
// Check permissions
const page = await db.query.pages.findFirst({
  where: eq(pages.id, fileId)
});

const canView = await canUserViewPage(userId, fileId);
if (!canView) {
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}

// Fetch from processor
const fileResponse = await fetch(
  `http://processor:3003/files/${page.contentHash}`
);

// Stream to client
return new Response(fileResponse.body, {
  headers: {
    'Content-Type': page.mimeType,
    'Content-Disposition': `inline; filename="${page.originalFileName}"`,
  },
});
```

## Integration Points

- **Pages System**: Files are FILE type pages
- **Permission System**: File access checks page permissions
- **AI System**: Images used in AI vision models
- **Processor Service**: External service for processing

## Best Practices

1. **Validate file size** before processing (100MB limit)
2. **Check permissions** before upload and view
3. **Sanitize filenames** (remove special characters)
4. **Content-addressed storage** prevents duplicates
5. **Process images** for optimal display
6. **Stream large files** don't load into memory

## Common Patterns

### Content-Addressed Storage

```typescript
// Generate content hash
const hash = createHash('sha256');
hash.update(buffer);
const contentHash = hash.digest('hex');

// Check if file exists
const existing = await db.query.pages.findFirst({
  where: eq(pages.contentHash, contentHash)
});

if (existing) {
  // File already uploaded, reuse
  return { contentHash, deduplicated: true };
}

// Store new file
await storeFile(buffer, contentHash);
```

### Processing Queue

```typescript
// Add to processing queue
await addImageJob(contentHash, 'ai-chat');

// Process asynchronously
async function processJobs() {
  const jobs = await getQueuedJobs();

  for (const job of jobs) {
    try {
      await processImage(job.contentHash, job.preset);
      await markJobComplete(job.id);
    } catch (error) {
      await markJobFailed(job.id, error.message);
    }
  }
}
```

## Audit Checklist

- [ ] File size validation (100MB limit)
- [ ] Permission checks on upload/view
- [ ] Filename sanitization
- [ ] Content hash generation
- [ ] Processing status tracked
- [ ] Error handling for processor failures
- [ ] Streaming for large files

## Related Documentation

- [File Upload](../../2.0-architecture/2.6-features/file-upload.md)
- [Processor Service](../../2.0-architecture/2.2-backend/processor-service.md)
- [Functions List: File Processing](../../1.0-overview/1.5-functions-list.md)

---

**Last Updated:** 2025-09-29
**Agent Type:** general-purpose