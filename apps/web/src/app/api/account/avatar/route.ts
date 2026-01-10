import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, users, eq } from '@pagespace/db';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };
import { createUserServiceToken, type ServiceScope } from '@pagespace/lib';

// Maximum file size: 5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

// Allowed image types
const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

// Processor service URL
const PROCESSOR_URL = process.env.PROCESSOR_URL || 'http://processor:3003';

const REQUIRED_AVATAR_SCOPES: ServiceScope[] = ['avatars:write'];

async function createAvatarServiceToken(
  userId: string,
  expirationTime: string
): Promise<{ token: string }> {
  // createUserServiceToken validates that the user is accessing their own resources
  const { token } = await createUserServiceToken(
    userId,
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

    // Delete old avatar if it exists and is a local file
    const oldUser = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (oldUser[0]?.image) {
      // Check if it's a local file (not an external URL)
      if (!oldUser[0].image.startsWith('http://') && !oldUser[0].image.startsWith('https://')) {
        // Send delete request to processor
        try {
          const { token: serviceToken } = await createAvatarServiceToken(userId, '2m');

          await fetch(`${PROCESSOR_URL}/api/avatar/${userId}`, {
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
    processorFormData.append('userId', userId);

    // Create service JWT token for processor authentication
    const { token: serviceToken } = await createAvatarServiceToken(userId, '5m');

    const uploadUrl = `${PROCESSOR_URL}/api/avatar/upload`;
    console.log('Uploading avatar to processor', {
      url: uploadUrl,
      userId: userId,
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
        const { token: serviceToken } = await createAvatarServiceToken(userId, '2m');

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
