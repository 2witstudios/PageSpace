import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';

const AUTH_OPTIONS = { allow: ['session'] as const };

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const user = await db.query.users.findFirst({
    where: eq(users.id, auth.userId),
    columns: { betaFeatures: true },
  });

  return NextResponse.json({ features: user?.betaFeatures ?? [] });
}
