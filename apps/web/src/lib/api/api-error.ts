/**
 * The one error body of the org, wallet, seat and policy routes: `{ error, code, ...extras }`
 * (see @pagespace/lib/organizations/api-error-codes). The UI maps `code` to copy.
 */
import { NextResponse } from 'next/server';
import type { OrgApiErrorCode } from '@pagespace/lib/organizations/api-error-codes';

export function apiError(
  status: number,
  code: OrgApiErrorCode,
  message: string,
  extras: Record<string, unknown> = {},
  headers?: Record<string, string>,
): NextResponse {
  return NextResponse.json({ ...extras, error: message, code }, headers ? { status, headers } : { status });
}
