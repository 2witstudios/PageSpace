import { NextResponse } from 'next/server';

/** The JSON answer for a refused org-drive action: the decision's own status, message and code. */
export function orgRefusalResponse(refusal: { status: number; message: string; code: string }): NextResponse {
  return NextResponse.json({ error: refusal.message, code: refusal.code }, { status: refusal.status });
}
