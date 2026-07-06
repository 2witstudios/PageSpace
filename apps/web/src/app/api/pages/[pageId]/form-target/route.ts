/**
 * Authenticated Forms settings API for a Canvas page — lets the Forms tab
 * (apps/web/.../canvas/CanvasFormsSettingsTab.tsx) wire an existing <form>
 * tag on the page to a Sheet, and manage the resulting grant, without going
 * through the AI tool (apps/web/src/lib/ai/tools/form-tools.ts). `pageId`
 * here is the CANVAS page's id, not the target Sheet's — targets are looked
 * up by their `canvasPageId` column, and a Canvas page can have more than one
 * (a landing page routinely has several: waitlist, contact, feedback).
 *
 * This route only manages the DB grant (Sheet header row + form_targets
 * row). All HTML markup work — detecting tags, deriving fields from a tag's
 * inputs, injecting the wiring, splicing it into page content, and deleting
 * a tag on archive — happens client-side (parse-form-tags.ts,
 * @pagespace/lib/forms/form-html's wireFormBlock, @pagespace/lib/forms/
 * embed-html), since that's Canvas-document editing, not a server concern.
 * The raw submit token is only ever available at creation time (only its
 * hash is persisted — see packages/db/src/schema/form-targets.ts).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope, canPrincipalEditPage } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { formFieldsSchema } from '@pagespace/lib/forms/field-schema';
import type { FormTarget } from '@pagespace/db/schema/form-targets';
import {
  createFormTarget,
  getFormTargetsByCanvasPageId,
  getFormTargetById,
  updateFormTargetStatus,
  FormTargetPageNotSheetError,
  FormTargetAlreadyActiveError,
  FormTargetArchivedError,
} from '@/services/api/form-target-service';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

function getWebAppUrl(): string {
  const url = process.env.WEB_APP_URL;
  if (!url) {
    throw new Error('WEB_APP_URL must be configured to provision a public form submit URL');
  }
  return url;
}

/** Never send the token hash/prefix to the client — they're internal. */
function sanitizeFormTarget(formTarget: FormTarget) {
  const { tokenHash: _tokenHash, tokenPrefix: _tokenPrefix, ...rest } = formTarget;
  return rest;
}

const createBodySchema = z.object({
  sheetPageId: z.string().min(1),
  fields: formFieldsSchema,
});

// Archiving goes through DELETE, not PATCH — it's a distinct, terminal
// action (deletes the tag from the page too, client-side) with its own
// audit event type, not a routine status toggle.
const patchBodySchema = z.object({
  formTargetId: z.string().min(1),
  status: z.enum(['active', 'paused']),
  reason: z.string().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to view this page' }, { status: 403 });
  }

  try {
    const formTargets = await getFormTargetsByCanvasPageId(pageId);
    return NextResponse.json({ formTargets: formTargets.map(sanitizeFormTarget) });
  } catch (error) {
    loggers.api.error('Error reading form targets:', error as Error);
    return NextResponse.json({ error: 'Failed to read form targets' }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const userId = auth.userId;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit this page' }, { status: 403 });
  }

  try {
    const body = createBodySchema.parse(await req.json());
    // Resolve before mutating anything — createFormTarget writes the Sheet
    // header row and inserts the active form_targets row; a WEB_APP_URL
    // misconfiguration discovered afterward would leave that mutation
    // orphaned (the raw token is unrecoverable, and the sheet's "one active
    // target" unique index would then block re-provisioning until someone
    // manually archives the orphaned row).
    const webAppBaseUrl = getWebAppUrl();

    const { token, formTarget } = await createFormTarget({
      sheetPageId: body.sheetPageId,
      fields: body.fields,
      createdBy: userId,
      mutationContext: { userId },
      canvasPageId: pageId,
    });

    const submitUrl = `${webAppBaseUrl}/api/public/forms/${token}/submit`;

    auditRequest(req, {
      eventType: 'data.write',
      userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'form-target-create', formTargetId: formTarget.id },
    });

    // formHtml is intentionally NOT built here — the client already has the
    // original <form> tag it's wiring up and injects the honeypot/script
    // into that (wireFormBlock), preserving the author's own markup instead
    // of replacing it with a freshly generated one.
    return NextResponse.json({ formTargetId: formTarget.id, submitUrl });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    if (error instanceof FormTargetPageNotSheetError || error instanceof FormTargetAlreadyActiveError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    loggers.api.error('Error creating form target:', error as Error);
    return NextResponse.json({ error: 'Failed to create form target' }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit this page' }, { status: 403 });
  }

  try {
    const body = patchBodySchema.parse(await req.json());

    // Scope the mutation to a target actually wired to THIS Canvas page —
    // formTargetId alone isn't enough to prove that (a caller with edit
    // access to some other page could otherwise pause/archive any target).
    const existing = await getFormTargetById(body.formTargetId);
    if (!existing || existing.canvasPageId !== pageId) {
      return NextResponse.json({ error: 'No form target with that id is set up on this page' }, { status: 404 });
    }

    const updated = await updateFormTargetStatus({
      formTargetId: body.formTargetId,
      status: body.status,
      statusReason: body.reason,
    });

    auditRequest(req, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'form-target-update', formTargetId: body.formTargetId, status: body.status },
    });

    return NextResponse.json({ formTarget: sanitizeFormTarget(updated) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    if (error instanceof FormTargetArchivedError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    loggers.api.error('Error updating form target:', error as Error);
    return NextResponse.json({ error: 'Failed to update form target' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canPrincipalEditPage(auth, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You do not have permission to edit this page' }, { status: 403 });
  }

  const formTargetId = new URL(req.url).searchParams.get('formTargetId');
  if (!formTargetId) {
    return NextResponse.json({ error: 'formTargetId query parameter is required' }, { status: 400 });
  }

  try {
    const existing = await getFormTargetById(formTargetId);
    if (!existing || existing.canvasPageId !== pageId) {
      return NextResponse.json({ error: 'No form target with that id is set up on this page' }, { status: 404 });
    }

    await updateFormTargetStatus({ formTargetId, status: 'archived' });

    auditRequest(req, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'page',
      resourceId: pageId,
      details: { operation: 'form-target-archive', formTargetId },
    });

    return NextResponse.json({ archived: true });
  } catch (error) {
    if (error instanceof FormTargetArchivedError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    loggers.api.error('Error archiving form target:', error as Error);
    return NextResponse.json({ error: 'Failed to archive form target' }, { status: 500 });
  }
}
