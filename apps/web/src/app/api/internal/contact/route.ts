import { NextResponse } from 'next/server';
import { db, contactSubmissions } from '@pagespace/db';
import { isValidEmail } from '@pagespace/lib/validators/email'
import { secureCompare } from '@pagespace/lib/auth/secure-compare';

export async function POST(request: Request) {
  const secret = process.env.INTERNAL_API_SECRET;

  if (!secret) {
    return NextResponse.json(
      { error: 'Internal API not configured' },
      { status: 503 }
    );
  }

  const authHeader = request.headers.get('authorization');
  const providedToken = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!providedToken || !secureCompare(providedToken, secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: { name?: string; email?: string; subject?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const { name, email, subject, message } = body;

  // Validate all fields server-side (don't trust the caller)
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return NextResponse.json({ error: 'Valid name is required (max 100 characters)' }, { status: 400 });
  }
  if (!email || typeof email !== 'string' || !isValidEmail(email)) {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
  }
  if (!subject || typeof subject !== 'string' || subject.trim().length === 0 || subject.length > 200) {
    return NextResponse.json({ error: 'Valid subject is required (max 200 characters)' }, { status: 400 });
  }
  if (!message || typeof message !== 'string' || message.trim().length < 10 || message.length > 2000) {
    return NextResponse.json({ error: 'Message must be between 10 and 2000 characters' }, { status: 400 });
  }

  try {
    await db.insert(contactSubmissions).values({
      name: name.trim(),
      email: email.trim(),
      subject: subject.trim(),
      message: message.trim(),
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error('Failed to insert contact submission:', error);
    return NextResponse.json(
      { error: 'Failed to save contact submission' },
      { status: 500 }
    );
  }
}
