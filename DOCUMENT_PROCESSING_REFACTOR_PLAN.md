# Document Processing Refactor Plan

## Executive Summary
Consolidate all document processing into the Processor service, eliminating redundant Worker service and duplicate queue systems. This plan MUST be followed step-by-step without deviation.

## Current Problem
- **Three competing systems** trying to do the same job
- **PDFs not being processed** because they fall between the cracks
- **Web app** still orchestrating when it shouldn't
- **Worker service** is completely redundant
- **Processor service** has unused queue system

## Target Architecture
```
User Upload → Web App (auth/DB only) → Processor Service
                                              ↓
                                    Store File + Queue Job
                                              ↓
                                    Process File Locally
                                              ↓
                                    Update DB with Results
```

## Implementation Steps (DO NOT DEVIATE)

### Phase 1: Enable Processor to Update Database
**Files to modify:**
1. `apps/processor/src/workers/text-extractor.ts`
   - Add database import and connection
   - After extraction, update page content in DB
   - Set processingStatus to 'completed' or 'visual'
   - Handle PDF text extraction (already has pdfjs-dist)
   - Handle DOCX extraction (already has mammoth)

2. `apps/processor/src/workers/image-processor.ts`
   - After optimization, update DB if needed
   - Mark images as 'visual' status

3. `apps/processor/src/workers/queue-manager.ts`
   - Ensure workers can access database
   - Add proper error handling and status updates

### Phase 2: Fix Job Queueing
**Files to modify:**
1. `apps/web/src/app/api/upload/route.ts`
   - REMOVE all calls to `getProducerQueue()`
   - REMOVE job queueing logic
   - Let processor handle ALL queueing after upload
   - Only create DB entry with initial status

2. `apps/processor/src/api/upload.ts`
   - Ensure `queueProcessingJobs()` is called for ALL file types
   - Verify PDF files trigger 'text-extract' queue
   - Return job IDs to web app for tracking

### Phase 3: Connect Processor Queue to DB Updates
**Files to modify:**
1. `apps/processor/src/workers/text-extractor.ts`
   - Implement `extractText()` to actually update DB:
   ```typescript
   import { db, pages, eq } from '@pagespace/db';

   // After extraction...
   await db.update(pages)
     .set({
       content: extractedText,
       processingStatus: extractedText ? 'completed' : 'visual',
       extractionMethod: 'text',
       processedAt: new Date()
     })
     .where(eq(pages.id, data.fileId));
   ```

2. `apps/processor/src/workers/ocr-processor.ts`
   - Similar DB update after OCR
   - Mark as 'visual' if no text found

### Phase 4: Remove Redundant Services
**Files/folders to DELETE:**
1. `apps/web/src/workers/file-processor.ts` - DELETE
2. `packages/lib/src/file-processor.ts` - DELETE
3. `packages/lib/src/job-queue.ts` - DELETE
4. `apps/web/Dockerfile.worker` - DELETE
5. Remove worker service from `docker-compose.yml`

**Code to REMOVE:**
1. In `apps/web/src/app/api/upload/route.ts`:
   - Remove: `import { getProducerQueue } from '@pagespace/lib/job-queue';`
   - Remove: All job queue related code (lines 254-289)

### Phase 5: Testing Checklist
**Test each file type:**
- [ ] Upload PDF → Verify text extraction → Check DB content
- [ ] Upload DOCX → Verify text extraction → Check DB content
- [ ] Upload image → Verify marked as 'visual' → AI can read it
- [ ] Upload text file → Verify content extracted → Check DB

**Verify:**
- [ ] No 'process-file' jobs in pgboss tables
- [ ] Processor's queues have jobs ('text-extract', 'image-optimize')
- [ ] Worker service is completely removed
- [ ] No duplicate processing code remains

### Phase 6: Update Documentation
**Files to update:**
1. `FILE_UPLOAD_ARCHITECTURE.md`
   - Remove references to Worker service
   - Update architecture diagram
   - Document single processor flow

2. `docker-compose.yml`
   - Remove worker service definition
   - Update comments about architecture

## Critical Rules
1. **DO NOT** create new processing systems
2. **DO NOT** add more queues
3. **DO NOT** keep Worker service "just in case"
4. **DO NOT** have Web app do any processing
5. **ONLY** Processor service processes files
6. **STICK TO THIS PLAN**

## Success Criteria
- PDFs are processed successfully
- DOCX files are processed successfully
- Images are marked as visual
- Only ONE service (Processor) handles processing
- Worker service is completely gone
- No duplicate code remains

## Rollback Plan
If issues arise:
1. Git stash changes
2. Restart from Phase 1
3. Test each phase thoroughly before proceeding

---

**NOTE**: This plan is the single source of truth. Do not deviate. Do not add "improvements". Just execute exactly as written.