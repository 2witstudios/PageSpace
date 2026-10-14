import { NextResponse } from 'next/server';
import type { PolicyRefusal } from '@pagespace/lib/organizations/sharing-decisions';

/** The JSON answer for a refusal by an org policy: its status, message, the code `org_policy`, and which policy. */
export function orgPolicyRefusalResponse(refusal: Pick<PolicyRefusal, 'status' | 'message' | 'code' | 'policy'>): NextResponse {
  return NextResponse.json({ error: refusal.message, code: refusal.code, policy: refusal.policy }, { status: refusal.status });
}
