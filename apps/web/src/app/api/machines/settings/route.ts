/**
 * Machine Settings API — the Machine page's Settings tab surface onto its own
 * name, description, access toggles, and destruction (Terminal — GA).
 *
 * GET    ?terminalId=<id>                                    → current settings (view-access)
 * PATCH  { terminalId, name?, description?, ...toggles }     → update settings (edit-access)
 * DELETE ?terminalId=<id>                                    → destroy the Machine (edit-access)
 *
 * A Machine's identity is its backing Terminal page (`terminalId`). Session-only
 * (no MCP/agent tokens) — this is a human/UI surface. Every request re-checks
 * access for the named page (view-level for GET, edit-level for PATCH/DELETE),
 * mirroring machine-projects/machine-branches/agent-terminals.
 *
 * DELETE has two side effects with a REQUIRED fail-safe order — trash the page
 * first (reversible), then tear down the Sprite — enforced in `deleteMachine`.
 */

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import {
  getMachineSettings,
  updateMachineSettings,
  deleteMachine,
  type MachineSettingsPatch,
} from '@pagespace/lib/services/machines/machine-settings';
import {
  canAccessMachine,
  canDeleteMachine,
  canViewMachine,
  createDbMachineSettingsStore,
  createMachineSpriteTeardown,
} from '@/lib/machines/machine-settings-runtime';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const RESOURCE_TYPE = 'machine';

function requireString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: NextResponse } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
  }
  return { ok: true, value };
}

// Constructed per-return (never module-level singletons): a Response body can
// only be read once, so a shared instance would fail on a second request.
const notFound = () => NextResponse.json({ error: 'Machine not found' }, { status: 404 });

/** Audit the authz denial (so SIEM can detect probing) and return a fresh 403. */
function forbidden(request: Request, userId: string, terminalId: string): NextResponse {
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId,
    resourceType: RESOURCE_TYPE,
    resourceId: terminalId,
    riskScore: 0.5,
  });
  return NextResponse.json({ error: 'You do not have access to this machine' }, { status: 403 });
}

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const terminalId = requireString(url.searchParams.get('terminalId'), 'terminalId');
  if (!terminalId.ok) return terminalId.error;

  if (!(await canViewMachine(auth.userId, terminalId.value))) return forbidden(request, auth.userId, terminalId.value);

  const settings = await getMachineSettings({ terminalId: terminalId.value, store: createDbMachineSettingsStore() });
  if (!settings) return notFound();
  return NextResponse.json({ settings });
}

/**
 * Build a validated patch from the request body. Returns a 400 response when a
 * present field has the wrong type, or when no updatable field is supplied at
 * all (an empty patch is a client error, not a no-op).
 */
function parsePatch(body: {
  name?: unknown;
  description?: unknown;
  visibleToGlobalAssistant?: unknown;
  allowPageAgents?: unknown;
}): { ok: true; patch: MachineSettingsPatch } | { ok: false; error: NextResponse } {
  const patch: MachineSettingsPatch = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length === 0) {
      return { ok: false, error: NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 }) };
    }
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      return { ok: false, error: NextResponse.json({ error: 'description must be a string or null' }, { status: 400 }) };
    }
    // Trim like `name`; whitespace-only collapses to null so it round-trips as a
    // cleared description rather than an apparently-blank-but-non-null value.
    const trimmed = body.description === null ? null : body.description.trim();
    patch.description = trimmed && trimmed.length > 0 ? trimmed : null;
  }
  if (body.visibleToGlobalAssistant !== undefined) {
    if (typeof body.visibleToGlobalAssistant !== 'boolean') {
      return { ok: false, error: NextResponse.json({ error: 'visibleToGlobalAssistant must be a boolean' }, { status: 400 }) };
    }
    patch.visibleToGlobalAssistant = body.visibleToGlobalAssistant;
  }
  if (body.allowPageAgents !== undefined) {
    if (typeof body.allowPageAgents !== 'boolean') {
      return { ok: false, error: NextResponse.json({ error: 'allowPageAgents must be a boolean' }, { status: 400 }) };
    }
    patch.allowPageAgents = body.allowPageAgents;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: NextResponse.json({ error: 'No settings fields provided' }, { status: 400 }) };
  }
  return { ok: true, patch };
}

export async function PATCH(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  let body: {
    terminalId?: unknown;
    name?: unknown;
    description?: unknown;
    visibleToGlobalAssistant?: unknown;
    allowPageAgents?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // `request.json()` returns `null` (or a primitive) for a body like `null` or `42`
  // without throwing — guard before property access so it's a 400, not a 500.
  if (body === null || typeof body !== 'object') {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const terminalId = requireString(body.terminalId, 'terminalId');
  if (!terminalId.ok) return terminalId.error;

  // Authorize BEFORE validating field shapes so an unauthorized caller can't
  // distinguish a well-formed patch (would-be 403) from a malformed one (400).
  if (!(await canAccessMachine(auth.userId, terminalId.value))) return forbidden(request, auth.userId, terminalId.value);

  const parsed = parsePatch(body);
  if (!parsed.ok) return parsed.error;

  const settings = await updateMachineSettings({
    terminalId: terminalId.value,
    patch: parsed.patch,
    store: createDbMachineSettingsStore(),
  });
  if (!settings) return notFound();

  auditRequest(request, {
    eventType: 'data.write',
    userId: auth.userId,
    resourceType: RESOURCE_TYPE,
    resourceId: terminalId.value,
    details: { fields: Object.keys(parsed.patch) },
    riskScore: 0,
  });
  return NextResponse.json({ settings });
}

export async function DELETE(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const url = new URL(request.url);
  const terminalId = requireString(url.searchParams.get('terminalId'), 'terminalId');
  if (!terminalId.ok) return terminalId.error;

  // Destroying a Machine trashes its page → requires DELETE permission (stricter
  // than the edit-gated GET/PATCH), so a drive member with edit-but-not-delete
  // cannot destroy Machines they lack delete rights on.
  if (!(await canDeleteMachine(auth.userId, terminalId.value))) return forbidden(request, auth.userId, terminalId.value);

  const result = await deleteMachine({
    terminalId: terminalId.value,
    store: createDbMachineSettingsStore(),
    sprite: createMachineSpriteTeardown(),
  });
  if (!result.ok) return notFound();

  auditRequest(request, {
    eventType: 'data.delete',
    userId: auth.userId,
    resourceType: RESOURCE_TYPE,
    resourceId: terminalId.value,
    details: { spriteTornDown: result.spriteTornDown },
    riskScore: 0.5,
  });
  return NextResponse.json({ success: true, spriteTornDown: result.spriteTornDown });
}
