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
Manages background job processing:

```typescript
interface QueueManager {
  addImageJob(contentHash: string, preset: string): Promise<void>
  addTextExtractionJob(contentHash: string, mimeType: string): Promise<void>
  addOCRJob(contentHash: string): Promise<void>
  processJobs(): Promise<void>
}
```

**Queue Features**:
- In-memory queue with persistence planned
- Job prioritization by type
- Retry logic for failed jobs
- Concurrent processing limits

### 5. Text Extractor (`apps/processor/src/workers/text-extractor.ts`)
Extracts text content from documents:

```typescript
interface TextExtractor {
  extractFromPDF(buffer: Buffer): Promise<string>
  extractFromDOCX(buffer: Buffer): Promise<string>
  extractFromText(buffer: Buffer): Promise<string>
}
```

**Status**: ⚠️ Partially implemented
- Text files: ✅ Direct extraction
- PDF files: ⚠️ Planned with pdf-parse
- DOCX files: ⚠️ Planned with mammoth

### 6. OCR Processor (`apps/processor/src/workers/ocr-processor.ts`)
Optical character recognition for images:

```typescript
interface OCRProcessor {
  processImage(buffer: Buffer): Promise<string>
  detectText(imageUrl: string): Promise<string>
}
```

**Status**: ⚠️ Not implemented
- Tesseract.js integration planned
- External OCR service support planned
- Language detection planned

## API Endpoints

### Upload Endpoint
```typescript
POST /upload
Headers: {
  'x-filename': string,  // Original filename
  'x-drive-id': string,  // Drive ID for permissions
  'x-user-id': string    // User ID for tracking
}
Body: Buffer (raw file data)

Response: {
  contentHash: string,
  originalName: string,
  size: number,
  mimeType: string,
  isNew: boolean,
  metadata: object
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
POST /optimize-for-ai
Body: {
  contentHash: string,
  maxSize?: number,
  quality?: number
}
Response: {
  data: string (base64),
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
├── ai-chat.jpg       # AI-optimized version
├── thumbnail.webp    # Thumbnail
├── preview.jpg       # Preview image
└── metadata.json     # Processing metadata
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
1. **Upload Reception**: Receive document
2. **Hash & Store**: Calculate hash and store original
3. **Type Detection**: Determine document type
4. **Text Extraction**: Extract text based on type
5. **Return Metadata**: Send processing status

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
- Web app maintains file metadata in PostgreSQL
- Processor maintains file system storage
- Content hash links database records to files
- No direct database access from processor

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