import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import {
  getUserStorageQuota,
  getUserFileCount,
  reconcileStorageUsage,
  STORAGE_TIERS,
  formatBytes
} from '@pagespace/lib/services/storage-limits';
import { db, pages, drives, eq, and, desc, inArray } from '@pagespace/db';

export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check for reconcile parameter
    const { searchParams } = new URL(request.url);
    const shouldReconcile = searchParams.get('reconcile') === 'true';

    // Reconcile if requested
    if (shouldReconcile) {
      try {
        const reconcileResult = await reconcileStorageUsage(user.id);
        console.log(`Storage reconciled for user ${user.id}:`, reconcileResult);
      } catch (error) {
        console.error('Storage reconciliation failed:', error);
      }
    }

    // Get user's storage quota
    const quota = await getUserStorageQuota(user.id);
    if (!quota) {
      return NextResponse.json({ error: 'Could not retrieve storage quota' }, { status: 500 });
    }

    // Get file count
    const fileCount = await getUserFileCount(user.id);

    // Get user's drives
    const userDrives = await db.query.drives.findMany({
      where: eq(drives.ownerId, user.id),
      columns: { id: true, name: true }
    });

    if (userDrives.length === 0) {
      return NextResponse.json({
        quota,
        tierInfo: STORAGE_TIERS[quota.tier],
        fileCount,
        files: [],
        largestFiles: [],
        fileTypeBreakdown: {},
        recentFiles: []
      });
    }

    const driveIds = userDrives.map(d => d.id);

    // Get all user's files
    const files = await db
      .select({
        id: pages.id,
        title: pages.title,
        fileSize: pages.fileSize,
        mimeType: pages.mimeType,
        createdAt: pages.createdAt,
        driveId: pages.driveId
      })
      .from(pages)
      .where(and(
        inArray(pages.driveId, driveIds),
        eq(pages.type, 'FILE'),
        eq(pages.isTrashed, false)
      ))
      .orderBy(desc(pages.createdAt));

    // Calculate file type breakdown
    const fileTypeBreakdown: Record<string, { count: number; totalSize: number }> = {};
    files.forEach(file => {
      const type = getFileTypeCategory(file.mimeType || 'unknown');
      if (!fileTypeBreakdown[type]) {
        fileTypeBreakdown[type] = { count: 0, totalSize: 0 };
      }
      fileTypeBreakdown[type].count++;
      fileTypeBreakdown[type].totalSize += file.fileSize || 0;
    });

    // Get largest files
    const largestFiles = [...files]
      .sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0))
      .slice(0, 10)
      .map(f => ({
        ...f,
        formattedSize: formatBytes(f.fileSize || 0)
      }));

    // Get recent files
    const recentFiles = files.slice(0, 10).map(f => ({
      ...f,
      formattedSize: formatBytes(f.fileSize || 0)
    }));

    // Calculate storage by drive
    const storageByDrive = userDrives.map(drive => {
      const driveFiles = files.filter(f => f.driveId === drive.id);
      const totalSize = driveFiles.reduce((sum, f) => sum + (f.fileSize || 0), 0);
      return {
        driveId: drive.id,
        driveName: drive.name,
        fileCount: driveFiles.length,
        totalSize,
        formattedSize: formatBytes(totalSize)
      };
    });

    return NextResponse.json({
      quota: {
        ...quota,
        formattedUsed: formatBytes(quota.usedBytes),
        formattedQuota: formatBytes(quota.quotaBytes),
        formattedAvailable: formatBytes(quota.availableBytes)
      },
      tierInfo: STORAGE_TIERS[quota.tier],
      fileCount,
      totalFiles: files.length,
      fileTypeBreakdown,
      largestFiles,
      recentFiles,
      storageByDrive
    });

  } catch (error) {
    console.error('Storage info error:', error);
    return NextResponse.json(
      { error: 'Failed to get storage info' },
      { status: 500 }
    );
  }
}

/**
 * Categorize file types for breakdown
 */
function getFileTypeCategory(mimeType: string): string {
  if (!mimeType || mimeType === 'unknown') return 'Other';

  if (mimeType.startsWith('image/')) return 'Images';
  if (mimeType.startsWith('video/')) return 'Videos';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('text/')) return 'Text';
  if (mimeType.includes('pdf')) return 'PDFs';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'Documents';
  if (mimeType.includes('sheet') || mimeType.includes('excel')) return 'Spreadsheets';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'Presentations';
  if (mimeType.includes('zip') || mimeType.includes('compress') || mimeType.includes('archive')) return 'Archives';

  return 'Other';
}