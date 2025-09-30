# User Storage Limiting Implementation Plan
## 1GB Storage Quota per User for PageSpace

### Executive Summary
This plan outlines the implementation of a storage quota system for PageSpace, limiting each user to 1GB of upload storage for page type files. The implementation follows a phased approach to ensure robust tracking, enforcement, and user experience.

---

## Phase 1: Database Schema Changes

### 1.1 Users Table Updates
```sql
-- Add storage tracking columns to users table
ALTER TABLE users ADD COLUMN storage_used BIGINT DEFAULT 0;
ALTER TABLE users ADD COLUMN storage_limit BIGINT DEFAULT 1073741824; -- 1GB in bytes
```

### 1.2 Pages Table Updates
```sql
-- Add file size tracking to pages table
ALTER TABLE pages ADD COLUMN file_size BIGINT DEFAULT 0;
ALTER TABLE pages ADD COLUMN is_file_page BOOLEAN DEFAULT FALSE;
```

### 1.3 New User Files Table
```sql
-- Create detailed file tracking table
CREATE TABLE user_files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  mime_type TEXT,
  uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  INDEX idx_user_files_user_id (user_id),
  INDEX idx_user_files_page_id (page_id)
);
```

**Implementation Location**: `packages/db/src/schema/core.ts`

---

## Phase 2: Storage Tracking Infrastructure

### 2.1 Storage Service Module
Create `packages/lib/src/services/storage.ts`:

```typescript
export interface StorageQuota {
  used: number;
  limit: number;
  percentage: number;
  remaining: number;
}

export class StorageService {
  // Calculate total storage used by a user
  async calculateUserStorage(userId: string): Promise<number>
  
  // Check if user can upload file of given size
  async checkStorageLimit(userId: string, fileSize: number): Promise<boolean>
  
  // Update user's storage usage
  async updateUserStorage(userId: string, delta: number): Promise<void>
  
  // Get user's storage quota info
  async getUserStorageQuota(userId: string): Promise<StorageQuota>
  
  // Recalculate storage from scratch (for migrations/repairs)
  async recalculateUserStorage(userId: string): Promise<number>
}
```

### 2.2 Database Triggers
```sql
-- Trigger to update user storage on file page creation
CREATE OR REPLACE FUNCTION update_user_storage_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.type = 'file' AND NEW.file_size > 0 THEN
    UPDATE users 
    SET storage_used = storage_used + NEW.file_size
    WHERE id = NEW.author_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update user storage on file page deletion
CREATE OR REPLACE FUNCTION update_user_storage_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.type = 'file' AND OLD.file_size > 0 THEN
    UPDATE users 
    SET storage_used = GREATEST(0, storage_used - OLD.file_size)
    WHERE id = OLD.author_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
```

---

## Phase 3: API Endpoint Updates

### 3.1 Upload Endpoint Enhancement
**Location**: `apps/web/src/app/api/upload/route.ts`

```typescript
export async function POST(request: Request) {
  // 1. Parse multipart form data
  const formData = await request.formData();
  const file = formData.get('file') as File;
  
  // 2. Get user from session
  const session = await getSession();
  const userId = session.user.id;
  
  // 3. Check storage limit BEFORE processing
  const fileSize = file.size;
  const canUpload = await storageService.checkStorageLimit(userId, fileSize);
  
  if (!canUpload) {
    const quota = await storageService.getUserStorageQuota(userId);
    return Response.json({
      error: 'Storage limit exceeded',
      quota,
    }, { status: 413 }); // Payload Too Large
  }
  
  // 4. Process upload
  // 5. Update storage tracking
  // 6. Return success with updated quota
}
```

### 3.2 File Management Endpoints
**Location**: `apps/web/src/app/api/files/[id]/route.ts`

```typescript
// DELETE endpoint to handle storage reclamation
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  
  // 1. Get file info before deletion
  const file = await db.select().from(pages).where(eq(pages.id, id)).first();
  
  // 2. Delete file from filesystem
  // 3. Delete database record
  // 4. Update user storage
  await storageService.updateUserStorage(file.authorId, -file.fileSize);
  
  return Response.json({ success: true });
}
```

### 3.3 Storage Stats Endpoint
**New Location**: `apps/web/src/app/api/users/[id]/storage/route.ts`

```typescript
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  
  const quota = await storageService.getUserStorageQuota(id);
  const files = await db.select()
    .from(userFiles)
    .where(eq(userFiles.userId, id))
    .orderBy(desc(userFiles.uploadedAt));
  
  return Response.json({
    quota,
    files,
    largestFiles: files.slice(0, 5).sort((a, b) => b.fileSize - a.fileSize),
  });
}
```

---

## Phase 4: Frontend Components

### 4.1 Storage Indicator Component
**Location**: `apps/web/src/components/storage/StorageIndicator.tsx`

```typescript
interface StorageIndicatorProps {
  used: number;
  limit: number;
  showDetails?: boolean;
}

export function StorageIndicator({ used, limit, showDetails }: StorageIndicatorProps) {
  const percentage = (used / limit) * 100;
  const remaining = limit - used;
  
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span>Storage Used</span>
        <span>{formatBytes(used)} / {formatBytes(limit)}</span>
      </div>
      <Progress value={percentage} className={cn(
        percentage > 90 && "bg-red-500",
        percentage > 75 && "bg-yellow-500"
      )} />
      {showDetails && (
        <p className="text-xs text-muted-foreground">
          {formatBytes(remaining)} remaining
        </p>
      )}
    </div>
  );
}
```

### 4.2 Upload Dialog Updates
**Location**: `apps/web/src/components/layout/left-sidebar/CreatePageDialog.tsx`

Add storage checking before file selection:
- Pre-flight storage check
- Show remaining storage
- Disable upload button if over limit
- Clear error messaging

### 4.3 User Settings Storage Section
**Location**: `apps/web/src/components/settings/StorageSettings.tsx`

Features:
- Current usage visualization
- File breakdown by type
- Largest files list
- Storage cleanup tools
- Request storage increase (future feature)

---

## Phase 5: File Upload Validation

### 5.1 Client-Side Validation
```typescript
// Before upload
const validateFileSize = async (file: File): Promise<ValidationResult> => {
  // Check file size
  if (file.size > 100 * 1024 * 1024) { // 100MB single file limit
    return { valid: false, error: 'File too large (max 100MB)' };
  }
  
  // Check user quota
  const quota = await fetchUserQuota();
  if (quota.remaining < file.size) {
    return { 
      valid: false, 
      error: `Insufficient storage (${formatBytes(quota.remaining)} remaining)` 
    };
  }
  
  return { valid: true };
};
```

### 5.2 Server-Side Validation
- Validate file size before processing
- Check storage quota atomically
- Handle race conditions with database locks
- Implement retry logic for concurrent uploads

---

## Phase 6: Migration & Cleanup

### 6.1 Migration Script
**Location**: `packages/db/scripts/migrate-storage.ts`

```typescript
async function migrateExistingStorage() {
  // 1. Get all users
  const users = await db.select().from(users);
  
  for (const user of users) {
    // 2. Calculate current storage from existing files
    const files = await db.select()
      .from(pages)
      .where(and(
        eq(pages.authorId, user.id),
        eq(pages.type, 'file')
      ));
    
    // 3. Calculate total size
    let totalSize = 0;
    for (const file of files) {
      if (file.content?.filePath) {
        const stats = await fs.stat(file.content.filePath);
        totalSize += stats.size;
        
        // Update file record with size
        await db.update(pages)
          .set({ fileSize: stats.size })
          .where(eq(pages.id, file.id));
      }
    }
    
    // 4. Update user storage
    await db.update(users)
      .set({ storageUsed: totalSize })
      .where(eq(users.id, user.id));
  }
}
```

### 6.2 Cleanup Jobs
- Remove orphaned files (files without database records)
- Clean up soft-deleted files after retention period
- Compress old files (optional future feature)

---

## Phase 7: Monitoring & Admin Tools

### 7.1 Admin Dashboard
**Location**: `apps/web/src/app/admin/storage/page.tsx`

Features:
- Total storage usage across all users
- Users approaching limits
- Storage growth trends
- Manual quota adjustments
- Bulk operations

### 7.2 Storage Analytics
Track and report:
- Average storage per user
- File type distribution
- Upload patterns
- Storage growth rate
- Quota violation attempts

### 7.3 Automated Monitoring
- Alert when user reaches 80% of quota
- Weekly storage reports
- Cleanup job status monitoring
- Failed upload tracking

---

## Implementation Considerations

### Performance
- **Caching**: Cache storage quotas with 5-minute TTL
- **Batch Updates**: Queue storage updates for batch processing
- **Indexes**: Add database indexes for storage queries
- **Lazy Calculation**: Only recalculate when necessary

### Security
- **Rate Limiting**: Prevent storage abuse through rapid uploads
- **File Type Validation**: Ensure only allowed file types
- **Path Traversal**: Prevent directory traversal attacks
- **Quota Bypass**: Prevent quota manipulation

### User Experience
- **Progressive Enhancement**: Show storage before hitting limits
- **Clear Messaging**: Explain storage limits and options
- **Graceful Degradation**: Allow read access even at limit
- **Storage Management**: Easy tools to free up space

### Scalability
- **Storage Tiers**: Support for multiple storage limits
- **External Storage**: Future S3/cloud storage support
- **Compression**: Optional file compression
- **Archival**: Move old files to cheaper storage

---

## Testing Strategy

### Unit Tests
- Storage calculation functions
- Quota checking logic
- File size formatting utilities

### Integration Tests
- Upload with storage limits
- Concurrent upload handling
- Storage reclamation on deletion
- Migration script correctness

### E2E Tests
- Complete upload flow with limits
- Storage indicator updates
- Error handling for quota exceeded

---

## Rollout Plan

### Week 1: Foundation
- Database schema changes
- Storage service implementation
- Basic tracking infrastructure

### Week 2: API Integration
- Upload endpoint updates
- File management changes
- Storage stats endpoint

### Week 3: Frontend
- Storage indicator component
- Upload dialog updates
- User settings integration

### Week 4: Polish & Deploy
- Migration script execution
- Testing and bug fixes
- Documentation updates
- Production deployment

---

## Future Enhancements

### Phase 2 Features
- **Storage Tiers**: Pro users get 10GB, Enterprise unlimited
- **Shared Storage**: Team/organization storage pools
- **Storage Analytics**: Detailed usage reports and insights
- **Compression**: Automatic file compression for certain types
- **CDN Integration**: Offload static files to CDN
- **Backup Integration**: Include backups in storage calculations
- **Storage Alerts**: Email notifications for quota warnings

### Technical Improvements
- **Chunked Uploads**: Support for large file uploads
- **Resume Uploads**: Handle interrupted uploads
- **Background Processing**: Async storage calculations
- **Storage Optimization**: Deduplication for identical files

---

## Risk Mitigation

### Identified Risks
1. **Data Loss**: Accidental file deletion during migration
   - Mitigation: Full backup before migration
   
2. **Performance Impact**: Storage calculations slow down app
   - Mitigation: Async processing and caching
   
3. **User Frustration**: Sudden storage limits
   - Mitigation: Grace period and clear communication
   
4. **Edge Cases**: Orphaned files, corrupted data
   - Mitigation: Robust cleanup jobs and validation

### Rollback Plan
1. Keep database backup before migration
2. Feature flag for storage enforcement
3. Quick disable switch in environment variables
4. Rollback scripts prepared and tested

---

## Success Metrics

### Technical Metrics
- Storage calculation accuracy: >99.9%
- Upload success rate: >95%
- API response time: <200ms for quota checks
- Migration completion: 100% of users

### User Metrics
- Upload failure rate due to quota: <5%
- Storage management actions per user
- Support tickets related to storage
- User satisfaction scores

---

## Documentation Updates Required

After implementation, update:
- `docs/1.0-overview/1.5-functions-list.md` - Add storage functions
- `docs/1.0-overview/1.4-api-routes-list.md` - Document new endpoints
- `docs/2.0-architecture/2.2-backend/database.md` - Schema changes
- `docs/3.0-guides-and-tools/` - Add storage management guide
- `CLAUDE.md` - Include storage patterns for future development

---

## Conclusion

This comprehensive plan provides a robust, scalable solution for implementing 1GB storage limits per user in PageSpace. The phased approach ensures minimal disruption while delivering a complete storage management system that can grow with the application's needs.