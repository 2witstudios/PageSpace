/**
 * Shared parsing and refusal copy for the owner-left automation routes ([D-OW-36]).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import type { OwnerLeftAutomationResult } from '@pagespace/lib/organizations/automation-ownership';

export const automationKindSchema = z.enum(['workflow', 'page_webhook']);

export const reassignAutomationSchema = z.object({ newOwnerId: z.string().min(1) });

type Refusal = Extract<OwnerLeftAutomationResult, { ok: false }>['reason'];

const REFUSAL_MESSAGES: Record<Refusal, string> = {
  not_member: 'Organization not found',
  insufficient_role: 'Only the Owner or an Admin can do that',
  not_found: 'Automation not found',
  owner_present: 'This automation\'s owner is still here; only an automation whose owner left can be reassigned or deleted here',
  new_owner_not_member: 'The new owner must be a member of this organization',
  new_owner_no_drive_access: 'The new owner must be able to reach the automation\'s drive',
};

export function automationRefusalResponse(result: Extract<OwnerLeftAutomationResult, { ok: false }>): Response {
  return NextResponse.json({ error: REFUSAL_MESSAGES[result.reason], code: result.reason }, { status: result.status });
}
