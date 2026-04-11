import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, verifyAdminAuth } from '@/lib/auth';
import { loggers, securityAudit, auditSafe } from '@pagespace/lib/server';
import { importOpenAPISpec } from '@pagespace/lib/integrations';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const importSchema = z.object({
  spec: z.string().min(1, 'Spec content is required'),
  selectedOperations: z.array(z.string()).optional(),
  baseUrlOverride: z.string().url().optional(),
});

/**
 * POST /api/integrations/providers/import-openapi
 * Parse an OpenAPI spec and return the generated provider config.
 * Admin only.
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const adminAuth = await verifyAdminAuth(request);
  if (adminAuth instanceof NextResponse) {
    return adminAuth;
  }

  try {
    const body = await request.json();
    const validation = importSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { spec, selectedOperations, baseUrlOverride } = validation.data;

    const result = await importOpenAPISpec(spec, {
      selectedOperations,
      baseUrlOverride,
    });

    auditSafe(securityAudit.logDataAccess(auth.userId, 'write', 'openapi_import', 'import'), auth.userId);

    return NextResponse.json({ result });
  } catch (error) {
    loggers.api.error('Error importing OpenAPI spec:', error as Error);
    const message = error instanceof Error ? error.message : 'Failed to import OpenAPI spec';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
