/**
 * Personalization settings.
 *
 * The profile CONTENT now lives as three markdown pages in the user's Home
 * drive (`Memory/About You`, `Memory/Communication`, `Memory/Rules`), edited
 * like any other page. This route no longer reads or writes that content — it
 * owns the `enabled` toggle and hands the client the links and previews it
 * needs to send the user to the real pages.
 */

import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { userPersonalization } from '@pagespace/db/schema/personalization';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { audit } from '@pagespace/lib/audit/audit-log';
import { getHomeDrive } from '@pagespace/lib/services/drive-service';
import {
  readMemoryPages,
  provisionMemoryPages,
  MEMORY_PAGE_TITLES,
  MEMORY_FIELDS,
  type MemoryField,
} from '@pagespace/lib/memory/memory-pages';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/** Characters of page content sent to the settings UI as a preview. */
const PREVIEW_LENGTH = 280;

interface MemoryPageSummary {
  field: MemoryField;
  title: string;
  pageId: string | null;
  href: string | null;
  preview: string;
  isEmpty: boolean;
}

const POINTER_COLUMN = {
  bio: 'bioPageId',
  writingStyle: 'writingStylePageId',
  rules: 'rulesPageId',
} as const;

// GET /api/settings/personalization - toggle state + links to the memory pages
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const homeDrive = await getHomeDrive(userId);

    // Self-heal a pointerless profile.
    //
    // A user who predates this feature has content in the legacy columns and no
    // page pointers, so every link below would be null: the screen would tell
    // them their memory pages are missing and give them no way to create one.
    // Rather than make that state depend on an operator remembering to run the
    // backfill, provision on read — this is precisely the moment the pages are
    // wanted, and `provisionMemoryPages` reuses anything that already exists.
    //
    // Deliberately does NOT copy legacy column content into the new pages; that
    // stays the backfill's job, so this path cannot race it into a double write.
    if (homeDrive) {
      const existing = await db.query.userPersonalization.findFirst({
        where: eq(userPersonalization.userId, userId),
        columns: { bioPageId: true, writingStylePageId: true, rulesPageId: true },
      });

      const missingPointer =
        !existing?.bioPageId || !existing?.writingStylePageId || !existing?.rulesPageId;

      if (missingPointer) {
        await db.transaction((tx) => provisionMemoryPages(userId, homeDrive.id, tx));
      }
    }

    const personalization = await db.query.userPersonalization.findFirst({
      where: eq(userPersonalization.userId, userId),
    });

    const content = personalization ? await readMemoryPages(userId) : {};

    const pages: MemoryPageSummary[] = MEMORY_FIELDS.map((field) => {
      const pageId = personalization?.[POINTER_COLUMN[field]] ?? null;
      const body = (content[field] ?? '').trim();

      return {
        field,
        title: MEMORY_PAGE_TITLES[field],
        pageId,
        href: pageId && homeDrive ? `/dashboard/${homeDrive.id}/${pageId}` : null,
        preview: body.slice(0, PREVIEW_LENGTH),
        isEmpty: body.length === 0,
      };
    });

    return NextResponse.json({
      personalization: {
        enabled: personalization?.enabled ?? true,
        memoryFolderHref:
          personalization?.memoryFolderId && homeDrive
            ? `/dashboard/${homeDrive.id}/${personalization.memoryFolderId}`
            : null,
        pages,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching personalization settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch personalization settings' },
      { status: 500 }
    );
  }
}

// PATCH /api/settings/personalization - update the enabled toggle
export async function PATCH(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { enabled } = body;

    if (enabled === undefined) {
      return NextResponse.json({ error: 'enabled is required' }, { status: 400 });
    }
    if (typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
    }

    const [record] = await db
      .insert(userPersonalization)
      .values({ userId, enabled })
      .onConflictDoUpdate({
        target: userPersonalization.userId,
        set: { enabled, updatedAt: new Date() },
      })
      .returning();

    audit({ eventType: 'admin.settings.changed', userId, resourceType: 'personalization' });

    return NextResponse.json({
      personalization: { enabled: record.enabled },
    });
  } catch (error) {
    loggers.api.error('Error updating personalization settings:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update personalization settings' },
      { status: 500 }
    );
  }
}
