import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { AVATAR_NOT_AN_IMAGE_MESSAGE, AVATAR_REJECTED_MESSAGE } from '@pagespace/lib/content-safety/avatar-gate';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
import { createUserServiceToken, type ServiceScope } from '@pagespace/lib/services/validated-service-token';
import { actorFromAuth } from '@/lib/auth/request-actor';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';

// Maximum file size: 5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Allowed image types
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

// Processor service URL
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

const REQUIRED_AVATAR_SCOPES: ServiceScope[] = ['avatars:write'];

async function createAvatarServiceToken(
  actor: AccessActor,
  expirationTime: string
): Promise<{ token: string }> {
  // createUserServiceToken validates that the user is accessing their own resources
  const { token } = await createUserServiceToken(
    actor,
    REQUIRED_AVATAR_SCOPES,
    expirationTime
  );
  return { token };
}

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Parse form data
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: 'Invalid file type. Please upload an image (JPEG, PNG, GIF, or WebP)' },
        { status: 400 }
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: 'File too large. Maximum size is 5MB' },
        { status: 400 }
      );
    }

    // The old avatar is NOT deleted here. The processor replaces it only after the new upload passes
    // the content-safety gate, so a refused upload leaves the current avatar in place.

    // Forward the file to processor service
    const processorFormData = new FormData();
    processorFormData.append('file', file);
    processorFormData.append('userId', userId);

    // Create opaque service token for processor authentication
    const { token: serviceToken } = await createAvatarServiceToken(actorFromAuth(auth), '5m');

    const uploadUrl = `${PROCESSOR_URL}/api/avatar/upload`;
    console.log('Uploading avatar to processor', {
      url: uploadUrl,
      userId: userId,
    });

    // Bounded so a stalled processor can't pin this request slot open —
    // the web instance has a hard cap on concurrent requests.
    let processorResponse: Response;
    try {
      processorResponse = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceToken}`
        },
        body: processorFormData,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        console.error('Processor avatar upload timed out', { userId });
        return NextResponse.json(
          { error: 'Avatar upload timed out, please try again' },
          { status: 504 }
        );
      }
      throw err;
    }

    // A refusal by the processor's gate. The message is fixed here, never the processor's text, and
    // never says why (not an image, or refused by the content-safety gate).
    const refusal = processorResponse.status === 400 || processorResponse.status === 422
      ? ((await processorResponse.clone().json().catch(() => ({}))) as { code?: unknown })
      : null;
    if (processorResponse.status === 422 || refusal?.code === 'not_an_image') {
      const notAnImage = refusal?.code === 'not_an_image';
      return NextResponse.json(
        { error: notAnImage ? AVATAR_NOT_AN_IMAGE_MESSAGE : AVATAR_REJECTED_MESSAGE },
        { status: processorResponse.status },
      );
    }

    if (!processorResponse.ok) {
      const errorData = await processorResponse.json().catch(() => ({}));
      console.error('Processor avatar upload rejected', {
        status: processorResponse.status,
        error: errorData.error,
        requiredScope: errorData.requiredScope,
        userId: userId,
      });
      throw new Error(errorData.error || 'Failed to upload avatar to processor');
    }

    const processorResult = await processorResponse.json();
    const { filename } = processorResult;

    // Update user record with API URL for the avatar
    const avatarUrl = `/api/avatar/${userId}/${filename}?t=${Date.now()}`; // Add timestamp for cache busting
    await db.update(users)
      .set({ image: avatarUrl })
      .where(eq(users.id, userId));

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'avatar', resourceId: userId, details: { operation: 'upload' } });

    return NextResponse.json({
      success: true,
      avatarUrl,
      message: 'Avatar uploaded successfully'
    });
  } catch (error) {
    console.error('Avatar upload error:', error);
    return NextResponse.json(
      { error: 'Failed to upload avatar' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Get current user avatar
    const currentUser = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!currentUser[0]?.image) {
      return NextResponse.json({ message: 'No avatar to delete' });
    }

    // Only delete if it's a local file (not an external URL)
    if (!currentUser[0].image.startsWith('http://') && !currentUser[0].image.startsWith('https://')) {
      // Send delete request to processor
      try {
        const { token: serviceToken } = await createAvatarServiceToken(actorFromAuth(auth), '2m');

        await fetch(`${PROCESSOR_URL}/api/avatar/${userId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${serviceToken}`
          }
        });
      } catch (error) {
        console.log('Could not delete avatar file:', error);
      }
    }

    // Clear avatar from database
    await db.update(users)
      .set({ image: null })
      .where(eq(users.id, userId));

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'avatar', resourceId: userId, details: { operation: 'delete' } });

    return NextResponse.json({
      success: true,
      message: 'Avatar deleted successfully'
    });
  } catch (error) {
    console.error('Avatar deletion error:', error);
    return NextResponse.json(
      { error: 'Failed to delete avatar' },
      { status: 500 }
    );
  }
}
