/** How every report route answers. Pure: no database, no email. */

import { NextResponse } from 'next/server';
import type { ReportOutcome } from '@pagespace/lib/content-safety/report-intake';
import { REPORT_REFUSAL_MESSAGES } from '@pagespace/lib/content-safety/reports';

export const REPORT_RECEIVED_MESSAGE = 'Report received. Thank you — our team will review it.';

const REFUSAL_STATUS = { not_pagespace_url: 400, not_found: 404, self_report: 400 } as const;

/** 201 with the CSAM guidance when it applies, or the neutral refusal. Never the case ID: the reporter doesn't need it. */
export function reportResponse(outcome: ReportOutcome): NextResponse {
  if (!outcome.ok) {
    return NextResponse.json({ error: REPORT_REFUSAL_MESSAGES[outcome.reason] }, { status: REFUSAL_STATUS[outcome.reason] });
  }
  return NextResponse.json(
    { message: REPORT_RECEIVED_MESSAGE, ...(outcome.csamGuidance ? { csamGuidance: outcome.csamGuidance } : {}) },
    { status: 201 },
  );
}
