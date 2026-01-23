import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib';
import { getActivityById } from '@/services/api';
import { loggers } from '@pagespace/lib/server';
import { readPageContent } from '@pagespace/lib/server';
import {
  diffContent,
  summarizeDiff,
  type DiffResult,
  type DiffOptions,
} from '@pagespace/lib/content';
import { maskIdentifier } from '@/lib/logging/mask';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: false };

const querySchema = z.object({
  v1: z.string().min(1, 'Version 1 ID is required'),
  v2: z.string().min(1, 'Version 2 ID is required'),
  lineMode: z.coerce.boolean().optional(),
  prettyPrint: z.coerce.boolean().optional(),
});

/**
 * Response type for version comparison
 */
interface VersionCompareResponse {
  /** The diff result between the two versions */
  diff: DiffResult;
  /** Human-readable summary of the changes */
  summary: string;
  /** Metadata about the compared versions */
  versions: {
    v1: VersionMetadata;
    v2: VersionMetadata;
  };
}

interface VersionMetadata {
  id: string;
  timestamp: Date;
  operation: string;
  actorEmail: string;
  actorDisplayName: string | null;
  contentSize: number | null;
  contentFormat: string | null;
  isAiGenerated: boolean;
}

/**
 * Resolves content from an activity record.
 * Reads from contentRef if available, falls back to contentSnapshot.
 */
async function resolveActivityContent(activity: {
  id: string;
  contentRef: string | null;
  contentSnapshot: string | null;
}): Promise<string | null> {
  if (activity.contentRef) {
    try {
      return await readPageContent(activity.contentRef);
    } catch (error) {
      loggers.api.warn('[VersionCompare] Failed to read content from ref', {
        activityId: activity.id,
        contentRef: activity.contentRef,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (activity.contentSnapshot) {
    return activity.contentSnapshot;
  }

  return null;
}

/**
 * GET /api/pages/[pageId]/versions/compare
 *
 * Compare two page versions and return a diff
 *
 * Query Parameters:
 * - v1: Version ID 1 (required)
 * - v2: Version ID 2 (required)
 * - lineMode: Use line-based diffing for better performance (optional)
 * - prettyPrint: Pretty-print JSON/tiptap content before diffing (optional)
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const { pageId } = await context.params;
  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  loggers.api.debug('[VersionCompare:Route] GET compare request', {
    pageId: maskIdentifier(pageId),
    userId: maskIdentifier(userId),
  });

  // Check permission to view the page
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    loggers.api.debug('[VersionCompare:Route] Permission denied');
    return NextResponse.json(
      { error: 'Unauthorized - you do not have access to this page' },
      { status: 403 }
    );
  }

  // Parse query params
  const parseResult = querySchema.safeParse({
    v1: searchParams.get('v1') ?? undefined,
    v2: searchParams.get('v2') ?? undefined,
    lineMode: searchParams.get('lineMode') ?? undefined,
    prettyPrint: searchParams.get('prettyPrint') ?? undefined,
  });

  if (!parseResult.success) {
    return NextResponse.json(
      { error: parseResult.error.issues.map((i) => i.message).join('. ') },
      { status: 400 }
    );
  }

  const { v1, v2, lineMode, prettyPrint } = parseResult.data;

  // Fetch both versions in parallel
  const [activity1, activity2] = await Promise.all([
    getActivityById(v1),
    getActivityById(v2),
  ]);

  // Validate version 1
  if (!activity1) {
    loggers.api.debug('[VersionCompare:Route] Version 1 not found', { v1 });
    return NextResponse.json(
      { error: `Version not found: ${v1}` },
      { status: 404 }
    );
  }

  // Validate version 2
  if (!activity2) {
    loggers.api.debug('[VersionCompare:Route] Version 2 not found', { v2 });
    return NextResponse.json(
      { error: `Version not found: ${v2}` },
      { status: 404 }
    );
  }

  // Verify both versions belong to the requested page
  if (activity1.pageId !== pageId) {
    loggers.api.warn('[VersionCompare:Route] Version 1 does not belong to page', {
      v1,
      versionPageId: activity1.pageId,
      requestedPageId: pageId,
    });
    return NextResponse.json(
      { error: `Version ${v1} does not belong to the requested page` },
      { status: 400 }
    );
  }

  if (activity2.pageId !== pageId) {
    loggers.api.warn('[VersionCompare:Route] Version 2 does not belong to page', {
      v2,
      versionPageId: activity2.pageId,
      requestedPageId: pageId,
    });
    return NextResponse.json(
      { error: `Version ${v2} does not belong to the requested page` },
      { status: 400 }
    );
  }

  // Read content for both versions
  const [content1, content2] = await Promise.all([
    resolveActivityContent(activity1),
    resolveActivityContent(activity2),
  ]);

  if (content1 === null) {
    loggers.api.warn('[VersionCompare:Route] Version 1 has no content', { v1 });
    return NextResponse.json(
      { error: `Version ${v1} has no content available` },
      { status: 400 }
    );
  }

  if (content2 === null) {
    loggers.api.warn('[VersionCompare:Route] Version 2 has no content', { v2 });
    return NextResponse.json(
      { error: `Version ${v2} has no content available` },
      { status: 400 }
    );
  }

  // Build diff options
  const diffOptions: DiffOptions = {
    lineMode: lineMode ?? false,
    prettyPrint: prettyPrint ?? true,
  };

  // If content format is available, use it
  if (activity1.contentFormat) {
    diffOptions.format = activity1.contentFormat;
  }

  // Generate the diff
  loggers.api.debug('[VersionCompare:Route] Generating diff', {
    v1,
    v2,
    content1Size: content1.length,
    content2Size: content2.length,
    options: diffOptions,
  });

  const startTime = Date.now();
  const diff = diffContent(content1, content2, diffOptions);
  const diffTime = Date.now() - startTime;

  const summary = summarizeDiff(diff);

  loggers.api.debug('[VersionCompare:Route] Diff generated', {
    isIdentical: diff.isIdentical,
    changesCount: diff.changes.length,
    stats: diff.stats,
    diffTimeMs: diffTime,
  });

  // Build response
  const response: VersionCompareResponse = {
    diff,
    summary,
    versions: {
      v1: {
        id: activity1.id,
        timestamp: activity1.timestamp,
        operation: activity1.operation,
        actorEmail: activity1.actorEmail,
        actorDisplayName: activity1.actorDisplayName,
        contentSize: activity1.contentSize,
        contentFormat: activity1.contentFormat,
        isAiGenerated: activity1.isAiGenerated,
      },
      v2: {
        id: activity2.id,
        timestamp: activity2.timestamp,
        operation: activity2.operation,
        actorEmail: activity2.actorEmail,
        actorDisplayName: activity2.actorDisplayName,
        contentSize: activity2.contentSize,
        contentFormat: activity2.contentFormat,
        isAiGenerated: activity2.isAiGenerated,
      },
    },
  };

  return NextResponse.json(response);
}
