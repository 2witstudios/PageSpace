/**
 * Who may reach a PERSONAL (driveless) calendar event through a credential.
 *
 * - An OAuth application (any OAuth principal short of the full-account grant):
 *   never. Its consent named drives, not the user's personal calendar, and a
 *   personal event's `createdById` is the USER — so the drive-scoped rule below
 *   would hand an app every personal event the user ever created (consent
 *   truthfulness, US10). Every calendar route applies this.
 * - A drive-scoped mcp_ key: only the user's OWN personal events (#1846) — it
 *   has no identity power over another user's personal event.
 * - A session, an unscoped key, an account grant: the user's own rules.
 */
import { NextResponse } from 'next/server';
import { isDriveScopedPrincipal, isScopedOAuthAuth, type AuthResult } from '@/lib/auth';

/** True when this event is a personal event and the principal is an OAuth application. */
export function isPersonalEventOutOfScope(auth: AuthResult, event: { readonly driveId: string | null }): boolean {
  return event.driveId === null && isScopedOAuthAuth(auth);
}

export function eventOutOfScopeResponse(): NextResponse {
  return NextResponse.json({ error: 'This token does not have access to this event' }, { status: 403 });
}

/**
 * The refusal for a personal event, or null: an OAuth application never reaches
 * one; any other drive-scoped principal reaches only its user's own.
 */
export function personalEventRefusal(
  auth: AuthResult,
  event: { readonly driveId: string | null; readonly createdById: string },
): NextResponse | null {
  if (event.driveId !== null) return null;
  if (isPersonalEventOutOfScope(auth, event)) return eventOutOfScopeResponse();
  if (event.createdById === auth.userId || !isDriveScopedPrincipal(auth)) return null;
  return eventOutOfScopeResponse();
}
