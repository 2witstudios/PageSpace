# PageSpace Processing Optimization Architecture

## Problem Statement

PageSpace has evolved from a lightweight document management system (native HTML files) to a heavy compute application with file uploads, OCR, and image processing. This fundamentally changes the scaling model:

- **Previously**: Could scale horizontally with minimal compute
- **Now**: File processing creates memory spikes, blocks the event loop, and prevents independent scaling
- **Current issue**: 4GB VPS struggling with concurrent users due to synchronous image processing in web server

## Current Architecture Issues

### 1. Monolithic Processing
- Web server handles UI, API, file uploads, AND image optimization
- Single point of failure - processing crash affects all users
- Memory spikes from image processing affect web performance

### 2. Synchronous Bottlenecks
- Image optimization happens during AI chat requests
- Sharp processing blocks the event loop
- Users experience delays during file operations

### 3. Resource Constraints
- Can't scale processing independently from web serving
- Limited to vertical scaling (adding more RAM)
- Expensive OCR API calls directly from web server

## Proposed Architecture

### Phase 1: Separate Processing Service (Immediate Priority)

#### 1.1 Create Dedicated Processing Service
**New service**: `apps/processor` - handles ALL file operations

**Responsibilities**:
- File uploads (move from web server)
- Text extraction (PDF, Word, etc.)
- Image optimization (Sharp processing)
- OCR operations
- Store processed results

**Technical specs**:
- Memory: 1-2GB dedicated (can scale independently)
- Returns: URLs or file IDs, never base64 data
- Port: 3003

#### 1.2 Processing API Endpoints
```
POST /process/upload         - Handle file uploads
POST /process/optimize-image - Optimize images for AI
GET  /process/status/:jobId  - Check processing status
GET  /files/:id              - Serve processed files
```

**Response pattern**: Return job IDs for async processing
**File serving**: Direct URLs or signed URLs

#### 1.3 Web Server Modifications
**Remove**:
- Sharp dependency from web app
- Direct file processing code
- Synchronous image optimization

**Update**:
- Visual content to use URLs from processor
- Upload endpoint to proxy to processor
- Reduce memory allocation to 512-768MB

### Phase 2: Storage Optimization

#### 2.1 Implement File Cache
- **Processed images**: Cache optimized versions
- **OCR results**: Store extracted text in DB
- **Deduplication**: Same file uploaded multiple times uses cached result
- **TTL**: 7-day cache for processed images

#### 2.2 Object Storage (Optional for scale)
**Options**:
- MinIO (self-hosted S3-compatible)
- Cloudflare R2 (if cloud acceptable)
- Local filesystem with nginx serving

**Benefits**:
- Offload file serving from Node.js
- Direct URLs for AI providers
- CDN-ready architecture
- Reduced memory usage

### Phase 3: Queue Enhancement

#### 3.1 Priority Queues
- **High priority**: Small files (<1MB), AI chat images
- **Normal priority**: Documents (1-10MB)
- **Low priority**: Large files (>10MB), batch operations

#### 3.2 Rate Limiting
- **OCR API calls**: Max 5 concurrent AI API requests
- **Processing slots**: Max 10 concurrent heavy operations
- **User limits**: Per-user upload rate limiting

## Implementation Details

### File Structure
```
apps/
├── web/                 # Lean web server (512-768MB)
│   └── removed: Sharp, file processing
├── processor/           # Processing service (1-2GB)
│   ├── src/
│   │   ├── routes/
│   │   │   ├── upload.ts
│   │   │   ├── optimize.ts
│   │   │   └── serve.ts
│   │   ├── services/
│   │   │   ├── file-processor.ts  # Moved from packages/lib
│   │   │   ├── image-optimizer.ts # Sharp operations
│   │   │   └── ocr-service.ts     # AI vision API calls
│   │   ├── queue/
│   │   │   └── processor-queue.ts
│   │   └── index.ts
│   ├── Dockerfile
│   └── package.json
├── realtime/           # Existing (unchanged)
└── worker/            # Can be merged into processor
```

### Docker Compose Configuration
```yaml
services:
  postgres:
    memory: 200M        # Unchanged
    
  web:
    memory: 768M        # Reduced from 1280M
    environment:
      - PROCESSOR_URL=http://processor:3003
      - NODE_OPTIONS=--max-old-space-size=640
    
  processor:            # NEW SERVICE
    build:
      context: .
      dockerfile: apps/processor/Dockerfile
    ports:
      - "3003:3003"
    memory: 1536M       # Dedicated processing memory
    volumes:
      - file_storage:/app/storage
      - processed_cache:/app/cache
    environment:
      - PORT=3003
      - NODE_OPTIONS=--max-old-space-size=1280
      - DATABASE_URL=postgresql://user:password@postgres:5432/pagespace
      - FILE_STORAGE_PATH=/app/storage
      - CACHE_PATH=/app/cache
    depends_on:
      - postgres
    
  realtime:
    memory: 256M        # Unchanged
    
  worker:
    memory: 256M        # Can be reduced or removed
```

### Memory Budget (4GB VPS)
| Service | Memory | Purpose |
|---------|--------|---------|
| PostgreSQL | 200MB | Database |
| Web | 768MB | UI/API serving |
| Processor | 1536MB | File processing |
| Realtime | 256MB | WebSocket |
| Worker | 256MB | Background jobs (or merge) |
| OS/Buffer | ~1GB | System overhead |
| **Total** | ~4GB | |

## Migration Plan

### Week 1: Foundation
1. Create `apps/processor` structure
2. Implement basic Express server
3. Add health check endpoint
4. Set up Docker configuration

### Week 2: Image Processing
1. Move Sharp operations to processor
2. Implement `/process/optimize-image` endpoint
3. Update visual-content-utils to use processor
4. Test with AI conversations

### Week 3: File Uploads
1. Move upload logic to processor
2. Implement `/process/upload` endpoint
3. Update web upload route to proxy
4. Migrate file-processor.ts

### Week 4: Optimization
1. Implement caching layer
2. Add priority queues
3. Performance testing
4. Monitor memory usage

## Benefits

### Immediate
- **50% memory reduction** in web server
- **No more heap crashes** from image processing
- **Faster response times** for web requests
- **Isolated failures** - processing issues don't affect UI

### Long-term
- **Horizontal scaling** - add processor instances as needed
- **GPU ready** - processor can be moved to GPU instance for better OCR
- **Microservice ready** - can split further if needed
- **Cost effective** - only scale what you need

## Future Enhancements

### Phase 4: Advanced OCR
- Local OCR with Tesseract.js
- GPU-accelerated processing
- Custom ML models for specific document types

### Phase 5: Distributed Processing
- Multiple processor instances
- Load balancing
- Geographic distribution

### Phase 6: Enhanced Caching
- Redis for metadata
- CDN integration
- Edge caching

## Monitoring & Metrics

### Key Metrics to Track
- Processing queue depth
- Average processing time by file type
- Memory usage per service
- OCR API costs
- Cache hit rates

### Alerting Thresholds
- Queue depth > 100 items
- Processing time > 30 seconds
- Memory usage > 80%
- Failed jobs > 5%

## Rollback Plan

If issues arise:
1. Route uploads back to web server
2. Re-enable Sharp in web (temporary)
3. Increase web server memory
4. Debug processor service offline

## Success Criteria

- Zero heap out of memory errors
- 90% of files processed within 10 seconds
- Web server memory stays under 768MB
- Support for 20+ concurrent file operations
- 50% reduction in OCR API costs (via caching)