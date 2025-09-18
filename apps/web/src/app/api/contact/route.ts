import { contactSubmissions, db } from '@pagespace/db';
import { z } from 'zod/v4';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/logger-config';

const contactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
  email: z.email('Valid email is required'),
  subject: z.string().min(1, 'Subject is required').max(200, 'Subject must be less than 200 characters'),
  message: z.string().min(10, 'Message must be at least 10 characters').max(2000, 'Message must be less than 2000 characters'),
});

export async function POST(request: Request) {
  const clientIP = request.headers.get('x-forwarded-for')?.split(',')[0] ||
                   request.headers.get('x-real-ip') ||
                   'unknown';

  try {
    const body = await request.json();
    const validation = contactSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({
        error: 'Validation failed',
        details: validation.error.flatten().fieldErrors
      }, { status: 400 });
    }

    const { name, email, subject, message } = validation.data;

    // Insert contact submission into database
    await db.insert(contactSubmissions).values({
      id: createId(),
      name,
      email,
      subject,
      message,
    });

    // Log the contact submission
    loggers.api.info('Contact form submission received', {
      name,
      email,
      subject,
      ip: clientIP,
      userAgent: request.headers.get('user-agent')
    });

    return Response.json({
      message: 'Contact submission received successfully. We will get back to you soon!'
    }, { status: 201 });

  } catch (error) {
    loggers.api.error('Contact form submission error', error as Error, { clientIP });
    return Response.json({
      error: 'An unexpected error occurred. Please try again later.'
    }, { status: 500 });
  }
}