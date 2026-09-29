import type { NextResponse } from 'next/server';
import { ORG_LAPSED_CODE, ORG_LAPSED_MESSAGE } from '@pagespace/lib/organizations/status';
import { orgRefusalResponse } from './org-refusal-response';

/**
 * SEAT-9: the one response an org-only capability returns while the org is lapsed —
 * 402 (payment required), the stable `code` the UI keys the reactivate banner on, and the
 * SEAT-9 message. Drives stay readable; nothing is deleted.
 */
export function orgLapsedResponse(message: string = ORG_LAPSED_MESSAGE): NextResponse {
  return orgRefusalResponse({ status: 402, message, code: ORG_LAPSED_CODE });
}
