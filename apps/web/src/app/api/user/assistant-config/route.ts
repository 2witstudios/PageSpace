import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getOrCreateConfig, updateConfig } from '@pagespace/lib/integrations/repositories/config-repository';
import { isMachineRefArray } from '@/lib/repositories/page-agent-repository';
import { globalTerminalConfigRepository, MAX_MACHINES } from '@/lib/repositories/global-terminal-config-repository';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const AUTH_OPTIONS_READ = { allow: ['session'] as const };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const machineRefSchema = z.union([
  z.object({ kind: z.literal('own') }),
  z.object({ kind: z.literal('existing'), terminalId: z.string().min(1) }),
]);

const updateConfigSchema = z.object({
  enabledUserIntegrations: z.array(z.string()).nullable().optional(),
  driveOverrides: z.record(z.string(), z.object({
    enabled: z.boolean(),
    enabledIntegrations: z.array(z.string()).optional(),
  })).optional(),
  inheritDriveIntegrations: z.boolean().optional(),
  terminalAccess: z.boolean().optional(),
  machines: z.array(machineRefSchema).max(MAX_MACHINES).optional(),
});

/**
 * GET /api/user/assistant-config
 * Get the global assistant configuration for the authenticated user.
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  auditRequest(request, { eventType: 'data.read', userId: auth.userId, resourceType: 'assistant_config', resourceId: 'self' });

  try {
    const config = await getOrCreateConfig(db, auth.userId);

    // Terminal pages in the user's Home drive they can see, for the "use
    // existing machine" picker — mirrors agent-config/route.ts's
    // availableTerminals, scoped to the Home drive (the global assistant's
    // stand-in for "the agent's own drive").
    let availableTerminals: Array<{ id: string; title: string }> = [];
    try {
      availableTerminals = await globalTerminalConfigRepository.getAvailableTerminals(auth.userId);
    } catch (error) {
      loggers.api.error('Error fetching available terminals:', error as Error);
      // Continue with an empty list on error
    }

    return NextResponse.json({
      config: {
        enabledUserIntegrations: config.enabledUserIntegrations,
        driveOverrides: config.driveOverrides,
        inheritDriveIntegrations: config.inheritDriveIntegrations,
        terminalAccess: config.terminalAccess ?? false,
        machines: isMachineRefArray(config.machines) ? config.machines : [],
        availableTerminals,
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

  auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'assistant_config', resourceId: 'self' });

  try {
    const body = await request.json();
    const validation = updateConfigSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    // Validate machines: verify every "existing" terminalId points to a
    // non-trashed TERMINAL page in the user's Home drive they can access —
    // mirrors agent-config/route.ts's scoping, so a caller can't attach a
    // Terminal outside their access via a direct API call.
    if (validation.data.machines !== undefined) {
      const machinesValidation = await globalTerminalConfigRepository.validateMachines(
        auth.userId,
        validation.data.machines,
      );
      if (!machinesValidation.ok) {
        return NextResponse.json(
          { error: `Invalid terminal reference(s): ${machinesValidation.invalidIds.join(', ')}` },
          { status: 400 },
        );
      }
    }

    const updateData: Record<string, unknown> = {};

    if (validation.data.enabledUserIntegrations !== undefined) {
      updateData.enabledUserIntegrations = validation.data.enabledUserIntegrations;
    }

    if (validation.data.inheritDriveIntegrations !== undefined) {
      updateData.inheritDriveIntegrations = validation.data.inheritDriveIntegrations;
    }

    if (validation.data.terminalAccess !== undefined) {
      updateData.terminalAccess = validation.data.terminalAccess;
    }

    if (validation.data.machines !== undefined) {
      updateData.machines = validation.data.machines;
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

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'config', resourceId: 'self' });

    return NextResponse.json({
      config: {
        enabledUserIntegrations: config.enabledUserIntegrations,
        driveOverrides: config.driveOverrides,
        inheritDriveIntegrations: config.inheritDriveIntegrations,
        terminalAccess: config.terminalAccess ?? false,
        machines: isMachineRefArray(config.machines) ? config.machines : [],
        updatedAt: config.updatedAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error updating assistant config:', error as Error);
    return NextResponse.json({ error: 'Failed to update config' }, { status: 500 });
  }
}
