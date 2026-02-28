import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { createOrganization, listUserOrganizations, getOrganizationBySlug } from '@pagespace/lib/server';
import { safeParseBody } from '@/lib/validation/parse-body';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const createOrgSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  slug: z.string().min(1, 'Slug is required').max(100)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(500).optional(),
});

export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const orgs = await listUserOrganizations(auth.userId);
    return NextResponse.json(orgs);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch organizations' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const parsed = await safeParseBody(request, createOrgSchema);
  if (!parsed.success) return parsed.response;

  const { name, slug, description } = parsed.data;

  try {
    // Check slug uniqueness
    const existing = await getOrganizationBySlug(slug);
    if (existing) {
      return NextResponse.json({ error: 'An organization with this slug already exists' }, { status: 409 });
    }

    const org = await createOrganization(auth.userId, { name, slug, description });
    return NextResponse.json(org, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to create organization' }, { status: 500 });
  }
}
