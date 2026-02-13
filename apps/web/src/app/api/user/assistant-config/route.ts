import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { getOrCreateConfig, updateConfig } from '@pagespace/lib/integrations';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const updateConfigSchema = z.object({
  enabledUserIntegrations: z.array(z.string()).nullable().optional(),
  driveOverrides: z.record(z.string(), z.object({
    enabled: z.boolean(),
    enabledIntegrations: z.array(z.string()).optional(),
  })).optional(),
  inheritDriveIntegrations: z.boolean().optional(),
});

/**
 * GET /api/user/assistant-config
 * Get the global assistant configuration for the authenticated user.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const config = await getOrCreateConfig(db, auth.userId);

    return NextResponse.json({
      config: {
        enabledUserIntegrations: config.enabledUserIntegrations,
        driveOverrides: config.driveOverrides,
        inheritDriveIntegrations: config.inheritDriveIntegrations,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching assistant config:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch config' }, { status: 500 });
  }
}

/**
 * PUT /api/user/assistant-config
 * Update the global assistant configuration.
 */
export async function PUT(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const body = await request.json();
    const validation = updateConfigSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = {};

    if (validation.data.enabledUserIntegrations !== undefined) {
      updateData.enabledUserIntegrations = validation.data.enabledUserIntegrations;
    }

    if (validation.data.inheritDriveIntegrations !== undefined) {
      updateData.inheritDriveIntegrations = validation.data.inheritDriveIntegrations;
    }

    // Merge driveOverrides with existing
    if (validation.data.driveOverrides !== undefined) {
      const existing = await getOrCreateConfig(db, auth.userId);
      const existingOverrides = (existing.driveOverrides as Record<string, unknown>) || {};
      updateData.driveOverrides = {
        ...existingOverrides,
        ...validation.data.driveOverrides,
      };
    }

    const config = await updateConfig(db, auth.userId, updateData);

    return NextResponse.json({
      config: {
        enabledUserIntegrations: config.enabledUserIntegrations,
        driveOverrides: config.driveOverrides,
        inheritDriveIntegrations: config.inheritDriveIntegrations,
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error updating assistant config:', error as Error);
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
}
