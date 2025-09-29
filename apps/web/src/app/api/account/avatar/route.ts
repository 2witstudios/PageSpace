import { NextRequest, NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { db, users, eq } from '@pagespace/db';
import {
  createServiceToken,
  verifyServiceToken,
  type ServiceTokenClaims,
} from '@pagespace/lib/auth-utils';

// Maximum file size: 5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Allowed image types
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

// Processor service URL
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

interface AvatarServiceToken {
  token: string;
  claims: ServiceTokenClaims;
}

const REQUIRED_AVATAR_SCOPES: ServiceTokenClaims['scopes'] = ['avatars:write'];

async function createAvatarServiceToken(userId: string, expirationTime: string): Promise<AvatarServiceToken> {
  const token = await createServiceToken('web', REQUIRED_AVATAR_SCOPES, {
    userId,
    tenantId: userId,
    expirationTime,
  });

  const claims = await verifyServiceToken(token);
  if (!claims) {
    throw new Error('Avatar service token verification failed');
  }

  const missingScopes = REQUIRED_AVATAR_SCOPES.filter((scope) => !claims.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(
      `Avatar service token missing required scopes: ${missingScopes.join(', ')} (scopes: ${
        claims.scopes.join(', ') || 'none'
      })`
    );
  }

  return { token, claims };
}

export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    // Delete old avatar if it exists and is a local file
    const oldUser = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (oldUser[0]?.image) {
      // Check if it's a local file (not an external URL)
      if (!oldUser[0].image.startsWith('http://') && !oldUser[0].image.startsWith('https://')) {
        // Send delete request to processor
        try {
          const { token: serviceToken } = await createAvatarServiceToken(user.id, '2m');

          await fetch(`${PROCESSOR_URL}/api/avatar/${user.id}`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${serviceToken}`
            }
          });
        } catch (error) {
          console.log('Could not delete old avatar:', error);
        }
      }
    }

    // Forward the file to processor service
    const processorFormData = new FormData();
    processorFormData.append('file', file);
    processorFormData.append('userId', user.id);

    // Create service JWT token for processor authentication
    const { token: serviceToken, claims: serviceTokenClaims } = await createAvatarServiceToken(user.id, '5m');

    const uploadUrl = `${PROCESSOR_URL}/api/avatar/upload`;
    console.log('Uploading avatar to processor', {
      url: uploadUrl,
      userId: user.id,
    });

    const processorResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceToken}`
      },
      body: processorFormData,
    });

    if (!processorResponse.ok) {
      const errorData = await processorResponse.json().catch(() => ({}));
      console.error('Processor avatar upload rejected', {
        status: processorResponse.status,
        error: errorData.error,
        requiredScope: errorData.requiredScope,
        tokenScopes: serviceTokenClaims.scopes,
        userId: user.id,
      });
      throw new Error(errorData.error || 'Failed to upload avatar to processor');
    }

    const processorResult = await processorResponse.json();
    const { filename } = processorResult;

    // Update user record with API URL for the avatar
    const avatarUrl = `/api/avatar/${user.id}/${filename}?t=${Date.now()}`; // Add timestamp for cache busting
    await db.update(users)
      .set({ image: avatarUrl })
      .where(eq(users.id, user.id));

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
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get current user avatar
    const currentUser = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!currentUser[0]?.image) {
      return NextResponse.json({ message: 'No avatar to delete' });
    }

    // Only delete if it's a local file (not an external URL)
    if (!currentUser[0].image.startsWith('http://') && !currentUser[0].image.startsWith('https://')) {
      // Send delete request to processor
      try {
        const { token: serviceToken } = await createAvatarServiceToken(user.id, '2m');

        await fetch(`${PROCESSOR_URL}/api/avatar/${user.id}`, {
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
      .where(eq(users.id, user.id));

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
