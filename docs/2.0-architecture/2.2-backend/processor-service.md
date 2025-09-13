# Processor Service Architecture

## Overview

The Processor Service is a dedicated microservice responsible for handling file storage, processing, and optimization in PageSpace. It runs as a separate Docker container to isolate memory-intensive operations from the main web application.

## Service Configuration

### Docker Setup
```yaml
processor:
  build:
    context: .
    dockerfile: apps/processor/Dockerfile
  ports:
    - "3003:3003"  # Internal port only
  environment:
    NODE_ENV: production
    NODE_OPTIONS: --max-old-space-size=1024
    PORT: 3003
    CACHE_PATH: /data/cache
    FILE_STORAGE_PATH: /data/files
  volumes:
    - cache_storage:/data/cache
    - file_storage:/data/files
  mem_limit: 1280m  # 1.25GB memory limit
```

### Memory Management
- **Allocated Memory**: 1280MB (1.25GB)
- **Node Heap Size**: 1024MB
- **Purpose**: Isolates memory-intensive image processing from main app
- **Buffer**: 256MB for system overhead

## Core Components

### 1. Express Server (`apps/processor/src/server.ts`)
```typescript
// Main server configuration
const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '100mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '100mb' }));
```

### 2. Content Store (`apps/processor/src/cache/content-store.ts`)
Manages file system operations with content-addressed storage:

```typescript
interface ContentStore {
  storeFile(buffer: Buffer, fileName: string): Promise<StoreResult>
  getFile(contentHash: string): Promise<Buffer | null>
  hasFile(contentHash: string): Promise<boolean>
  getMetadata(contentHash: string): Promise<FileMetadata | null>
}
```

**Key Features**:
- SHA256 content hashing for deduplication
- Atomic file writes with temporary files
- Metadata preservation in JSON format
- Directory structure management

### 3. Image Processor (`apps/processor/src/workers/image-processor.ts`)
Handles image optimization with multiple presets:

```typescript
const IMAGE_PRESETS = {
  'ai-chat': {
    maxWidth: 1920,
    quality: 85,
    format: 'jpeg'
  },
  'ai-vision': {
    maxWidth: 2048,
    quality: 90,
    format: 'jpeg'
  },
  'thumbnail': {
    maxWidth: 200,
    maxHeight: 200,
    quality: 80,
    format: 'webp'
  },
  'preview': {
    maxWidth: 800,
    quality: 85,
    format: 'jpeg'
  }
};
```

**Processing Features**:
- Sharp library for image manipulation
- Format conversion (JPEG, WebP, PNG)
- Intelligent resizing with aspect ratio preservation
- Quality optimization for different use cases

### 4. Queue Manager (`apps/processor/src/workers/queue-manager.ts`)
Manages durable background jobs via PgBoss with unified ingestion:

```typescript
type JobType = 'ingest-file' | 'image-optimize' | 'text-extract' | 'ocr-process';

interface QueueManager {
  addJob(type: JobType, data: any, options?: any): Promise<string>;
  getJob(jobId: string): Promise<ProcessingJob | null>;
  getQueueStatus(): Promise<Record<string, any>>;
}
```

**Queue Features**:
- Durable PgBoss queues (PostgreSQL-backed)
- Unified `ingest-file` job for all uploads (documents/images)
- Per-job prioritization and retries with backoff
- Controlled concurrency per worker (image/text/OCR)

### 5. Text Extractor (`apps/processor/src/workers/text-extractor.ts`)
Extracts text content from documents and writes cache artifacts:

```typescript
// Uses pdfjs-dist for PDFs and mammoth for DOCX
export async function extractText(data: {
  contentHash: string;
  fileId: string; // pageId
  mimeType: string;
  originalName: string;
}): Promise<{ success: boolean; text?: string; metadata?: any }>;
```

**Status**: ✅ Implemented
- Text files: ✅ Direct extraction
- PDF files: ✅ via pdfjs-dist
- DOCX files: ✅ via mammoth
- Caches to `/cache/{hash}/extracted-text.txt`

### 6. OCR Processor (`apps/processor/src/workers/ocr-processor.ts`)
Optical character recognition for images:

```typescript
interface OCRProcessor {
  processImage(buffer: Buffer): Promise<string>
  detectText(imageUrl: string): Promise<string>
}
```

**Status**: ⚠️ Partially implemented
- Tesseract.js and AI-vision paths available behind `ENABLE_OCR`
- Caches to `/cache/{hash}/ocr-text.txt`

## Unified Ingestion Pipeline

All uploads are queued as a single `ingest-file` job. The processor classifies the file and orchestrates extraction/optimization, then updates the `pages` record.

**Job Contract**
- `type`: `ingest-file`
- `data`: `{ pageId, contentHash, mimeType, originalName, priority?, traceId? }`
- Idempotency: keyed by `contentHash` (+ `pageId`); checks cache before work.

**Behavior**
- Images → mark `processingStatus=visual`, `extractionMethod=visual`; queue `image-optimize` for `ai-chat` and `thumbnail`; optionally queue `ocr-process` if OCR enabled.
- PDFs/DOCX/TXT → attempt text extraction; if text found, write to `pages.content` and set `completed`; if no text (scanned PDF), set `visual` and optionally queue `ocr-process`.
- Failures → set `failed` with error; retries with backoff.

**DB Updates (Processor-owned)**
- Processor writes: `content`, `processingStatus`, `extractionMethod`, `extractionMetadata`, `contentHash`, `processedAt`, `processingError`.
- Web enqueues and reads; processor is the sole updater for processing fields.

## API Endpoints

### Upload Endpoint
```typescript
POST /api/upload/single
Headers: {
  (multipart form-data)
}
Body: file (binary), pageId, userId

Response: {
  contentHash: string,
  originalName: string,
  size: number,
  mimeType: string,
  deduplicated: boolean,
  jobs: { ingest?: true } | { textExtraction?: true; imageOptimization?: string[]; ocr?: true }
}
```

### Serve Endpoints
```typescript
// Get original file
GET /cache/:contentHash/original
Response: Binary file data

// Get optimized version
GET /cache/:contentHash/:preset
Response: Optimized file data

// Get file metadata
GET /cache/:contentHash/metadata
Response: JSON metadata
```

### Image Optimization Endpoint
```typescript
POST /api/optimize/prepare-for-ai
Body: {
  contentHash: string,
  maxSize?: number,
  quality?: number
}
Response: {
  // Either a URL to cached asset or base64 depending on provider
  type: 'url' | 'base64',
  url?: string,
  data?: string,
  mimeType: string,
  size: number
}
```

### Health Check
```typescript
GET /health
Response: {
  status: 'ok',
  uptime: number,
  memory: object,
  storage: object
}
```

## File Storage Structure

### Original Files
```
/data/files/{contentHash}/
├── original          # Original uploaded file
└── metadata.json     # File metadata
```

**Metadata Structure**:
```json
{
  "contentHash": "sha256_hash",
  "originalName": "document.pdf",
  "size": 1048576,
  "mimeType": "application/pdf",
  "uploadedAt": "2025-01-15T10:00:00Z",
  "uploadedBy": "user_id",
  "driveId": "drive_id"
}
```

### Cached/Processed Files
```
/data/cache/{contentHash}/
├── ai-chat.jpg          # AI-optimized version
├── thumbnail.webp       # Thumbnail
├── preview.jpg          # Preview image
├── extracted-text.txt   # Extracted text (if available)
├── ocr-text.txt         # OCR text (if available)
└── metadata.json        # Processing metadata
```

**Cache Metadata**:
```json
{
  "contentHash": "sha256_hash",
  "presets": {
    "ai-chat": {
      "size": 204800,
      "format": "jpeg",
      "width": 1920,
      "height": 1080,
      "processedAt": "2025-01-15T10:01:00Z"
    }
  }
}
```

## Processing Workflows

### Image Processing Flow
1. **Upload Reception**: Receive file via HTTP POST
2. **Hash Calculation**: Calculate SHA256 of content
3. **Deduplication Check**: Check if file already exists
4. **Storage**: Save original file if new
5. **Queue Jobs**: Add optimization jobs to queue
6. **Process Presets**: Generate optimized versions
7. **Cache Storage**: Store processed versions

### Document Processing Flow
1. **Upload Reception**: Receive document via `/api/upload/single`
2. **Hash & Store**: Calculate hash and store original
3. **Enqueue**: Queue `ingest-file { pageId, contentHash, mimeType }`
4. **Return 202**: Web returns Accepted and shows processing state
5. **Processor Worker**: Classify (text vs visual); extract text or set `visual`; queue OCR optionally
6. **Persist**: Update `pages` with content/status/metadata
7. **Artifacts**: Save `extracted-text.txt` / `ocr-text.txt` and image presets

## Error Handling

### Common Error Scenarios
1. **File Too Large**: Return 413 with error message
2. **Unsupported Type**: Return 415 with supported types list
3. **Storage Full**: Return 507 with storage status
4. **Processing Failed**: Return 500, keep original, log error

### Retry Logic
```typescript
const RETRY_CONFIG = {
  maxAttempts: 3,
  backoffMultiplier: 2,
  initialDelay: 1000,
  maxDelay: 10000
};
```

## Performance Optimizations

### Memory Management
- Stream large files instead of loading into memory
- Use Sharp's streaming API for images
- Implement garbage collection hints
- Monitor memory usage and throttle processing

### Caching Strategy
- LRU cache for frequently accessed files
- Aggressive caching headers for immutable content
- Background cache warming for popular files
- Cache invalidation on storage limits

### Concurrency Control
```typescript
const CONCURRENCY_LIMITS = {
  imageProcessing: 2,      // Max 2 concurrent image jobs
  textExtraction: 3,       // Max 3 concurrent text jobs
  ocrProcessing: 1,        // Max 1 OCR job (resource intensive)
  maxQueueSize: 100        // Max queue size before throttling
};
```

## Integration Points

### Web Application Integration
```typescript
// From web app to processor
const response = await fetch(`${PROCESSOR_URL}/upload`, {
  method: 'POST',
  headers: {
    'x-filename': file.name,
    'x-drive-id': driveId,
    'x-user-id': userId
  },
  body: fileBuffer
});
```

### Database Synchronization
- Web app maintains file/page metadata and enqueues ingestion
- Processor maintains file system storage AND updates processing fields in PostgreSQL
- Content hash links database records to files
- Processor uses least-privileged DB access scoped to the `pages` table processing columns

### AI Service Integration
```typescript
// Loading images for AI vision
const imageData = await fetch(
  `${PROCESSOR_URL}/cache/${contentHash}/ai-vision`
);
const base64 = await imageData.text();
```

## Monitoring & Logging

### Health Metrics
```typescript
interface HealthMetrics {
  uptime: number;
  memoryUsage: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  storageUsage: {
    files: number;
    totalSize: number;
    availableSpace: number;
  };
  queueStatus: {
    pending: number;
    processing: number;
    failed: number;
  };
}
```

### Logging Strategy
- Structured JSON logging
- Log levels: ERROR, WARN, INFO, DEBUG
- File processing audit trail
- Performance metrics logging

## Security Measures

### Input Validation
- File type validation via magic bytes
- Filename sanitization
- Size limit enforcement (100MB)
- Content hash verification

### Access Control
- No direct external access (internal network only)
- Request validation via headers
- Rate limiting per user/drive
- Storage quota enforcement

### Data Protection
- Content-addressed storage prevents tampering
- Immutable file storage
- No execution of uploaded content
- Isolated processing environment

## Future Enhancements

### Planned Features
1. **Text Extraction**: Complete PDF and DOCX support
2. **OCR Integration**: Tesseract.js for image text
3. **Video Processing**: Thumbnail generation for videos
4. **Metadata Extraction**: EXIF, document properties
5. **Virus Scanning**: ClamAV integration

### Scalability Plans
1. **Distributed Storage**: S3-compatible object storage
2. **Queue Service**: Redis or RabbitMQ for job queue
3. **Worker Pools**: Separate workers for different tasks
4. **CDN Integration**: CloudFront or similar for serving
5. **Horizontal Scaling**: Multiple processor instances

### Performance Improvements
1. **WebAssembly**: WASM-based image processing
2. **GPU Acceleration**: For AI and image processing
3. **Streaming Uploads**: Chunked upload support
4. **Progressive Enhancement**: Progressive image loading
5. **Smart Caching**: ML-based cache prediction

## Development & Testing

### Local Development
```bash
# Start processor service
cd apps/processor
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build
```

### Testing Strategies
1. **Unit Tests**: Component-level testing
2. **Integration Tests**: API endpoint testing
3. **Load Tests**: Performance and memory testing
4. **Chaos Testing**: Failure scenario testing

### Debugging Tools
- Memory profiling with Chrome DevTools
- Network inspection with Wireshark
- File system monitoring with fs events
- Performance profiling with clinic.js
