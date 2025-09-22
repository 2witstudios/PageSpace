import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };
import { db, pages, eq } from '@pagespace/db';
import { canUserEditPage } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * POST /api/pages/bulk/rename
 * Rename multiple pages using find/replace patterns or templates
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const body = await request.json();
    const { pageIds, renamePattern } = body;

    if (!pageIds || !Array.isArray(pageIds) || pageIds.length === 0) {
      return NextResponse.json(
        { error: 'pageIds array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (!renamePattern || !renamePattern.type) {
      return NextResponse.json(
        { error: 'renamePattern with type is required' },
        { status: 400 }
      );
    }

    // Runtime validation for required fields based on pattern type
    switch (renamePattern.type) {
      case 'find_replace':
        if (!renamePattern.find || !renamePattern.replace) {
          return NextResponse.json(
            { error: 'Find/replace pattern requires find and replace fields' },
            { status: 400 }
          );
        }
        break;
      case 'prefix':
        if (!renamePattern.prefix) {
          return NextResponse.json(
            { error: 'Prefix pattern requires prefix field' },
            { status: 400 }
          );
        }
        break;
      case 'suffix':
        if (!renamePattern.suffix) {
          return NextResponse.json(
            { error: 'Suffix pattern requires suffix field' },
            { status: 400 }
          );
        }
        break;
      case 'template':
        if (!renamePattern.template) {
          return NextResponse.json(
            { error: 'Template pattern requires template field' },
            { status: 400 }
          );
        }
        break;
      default:
        return NextResponse.json(
          { error: 'Invalid pattern type. Must be one of: find_replace, prefix, suffix, template' },
          { status: 400 }
        );
    }

    // Check permissions and get pages
    const pagesToRename: Array<{ id: string; title: string; driveId: string }> = [];
    for (const pageId of pageIds) {
      const canEdit = await canUserEditPage(userId, pageId);
      if (!canEdit) {
        return NextResponse.json(
          { error: `No permission to rename page ${pageId}` },
          { status: 403 }
        );
      }

      const [page] = await db
        .select()
        .from(pages)
        .where(eq(pages.id, pageId));

      if (page && !page.isTrashed) {
        pagesToRename.push(page);
      } else {
        return NextResponse.json(
          { error: `Page ${pageId} not found or is trashed` },
          { status: 404 }
        );
      }
    }

    // Apply rename pattern
    const renamedPages: Array<{ id: string; oldTitle: string; newTitle: string; type: string }> = [];
    await db.transaction(async (tx) => {
      for (let i = 0; i < pagesToRename.length; i++) {
        const page = pagesToRename[i];
        let newTitle = page.title;

        switch (renamePattern.type) {
          case 'find_replace':
            if (renamePattern.caseSensitive) {
              newTitle = page.title.replace(
                new RegExp(renamePattern.find, 'g'),
                renamePattern.replace
              );
            } else {
              newTitle = page.title.replace(
                new RegExp(renamePattern.find, 'gi'),
                renamePattern.replace
              );
            }
            break;

          case 'prefix':
            newTitle = renamePattern.prefix + page.title;
            break;

          case 'suffix':
            newTitle = page.title + renamePattern.suffix;
            break;

          case 'template':
            newTitle = renamePattern.template
              .replace('{title}', page.title)
              .replace('{index}', String(i + 1));
            break;
        }

        if (newTitle !== page.title) {
          const [renamed] = await tx
            .update(pages)
            .set({
              title: newTitle,
              updatedAt: new Date(),
            })
            .where(eq(pages.id, page.id))
            .returning();

          renamedPages.push({
            id: renamed.id,
            oldTitle: page.title,
            newTitle: renamed.title,
            type: renamed.type,
          });

          // Broadcast update event
          await broadcastPageEvent(
            createPageEventPayload(page.driveId, renamed.id, 'updated', {
              title: renamed.title,
            })
          );
        }
      }
    });

    loggers.api.info('Bulk rename pages completed', {
      pageIds,
      pattern: renamePattern.type,
      renamedCount: renamedPages.length,
      userId
    });

    return NextResponse.json({
      success: true,
      pattern: renamePattern.type,
      renamedCount: renamedPages.length,
      unchangedCount: pagesToRename.length - renamedPages.length,
      renamedPages,
      summary: `Renamed ${renamedPages.length} of ${pagesToRename.length} page${pagesToRename.length === 1 ? '' : 's'}`,
      stats: {
        totalProcessed: pagesToRename.length,
        renamed: renamedPages.length,
        unchanged: pagesToRename.length - renamedPages.length,
      },
      nextSteps: [
        'Review renamed pages to ensure correctness',
        'Use list_pages to see the updated structure',
        'Update any hardcoded references to old titles',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in bulk rename pages:', error as Error);
    return NextResponse.json(
      { error: `Bulk rename failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
