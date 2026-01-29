import { db, feedbackSubmissions } from '@pagespace/db';
import { z } from 'zod/v4';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security';
import { ALLOWED_IMAGE_TYPES, validateImageAttachment } from '@/lib/validation/image-validation';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_TOTAL_SIZE = 25 * 1024 * 1024; // 25MB total

const attachmentSchema = z.object({
  name: z.string().max(255),
  type: z.enum(ALLOWED_IMAGE_TYPES),
  data: z.string(), // base64 data URL - validated via magic bytes below
});

const contextSchema = z.object({
  pageUrl: z.string().max(2000).optional(),
  userAgent: z.string().max(500).optional(),
  screenSize: z.string().max(50).optional(),
  viewportSize: z.string().max(50).optional(),
  appVersion: z.string().max(50).optional(),
  consoleErrors: z.array(z.string().max(1000)).max(10).optional(),
});

const feedbackSchema = z.object({
  message: z.string()
    .min(1, 'Feedback message is required')
    .max(2000, 'Message must be less than 2000 characters'),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
  context: contextSchema.optional(),
});

export async function POST(request: Request) {
  try {
    // Authenticate - feedback requires login
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const { userId } = auth;

    // Rate limit by user
    const rateLimitResult = await checkDistributedRateLimit(
      `feedback:${userId}`,
      DISTRIBUTED_RATE_LIMITS.CONTACT_FORM // Reuse contact form limits
    );

    if (!rateLimitResult.allowed) {
      loggers.api.warn('Feedback rate limit exceeded', { userId });
      return Response.json(
        { error: 'Too many feedback submissions. Please try again later.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(rateLimitResult.retryAfter || 3600),
          },
        }
      );
    }

    const body = await request.json();
    const validation = feedbackSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({
        error: 'Validation failed',
        details: validation.error.flatten().fieldErrors
      }, { status: 400 });
    }

    const { message, attachments, context } = validation.data;

    // Validate attachments: size limits and zero-trust content validation
    if (attachments && attachments.length > 0) {
      let totalSize = 0;
      for (const attachment of attachments) {
        // Base64 data URLs are ~33% larger than the binary
        const estimatedSize = Math.ceil((attachment.data.length * 3) / 4);
        if (estimatedSize > MAX_ATTACHMENT_SIZE) {
          return Response.json({
            error: `Attachment "${attachment.name}" exceeds maximum size of 10MB`
          }, { status: 400 });
        }
        totalSize += estimatedSize;

        // Zero-trust validation: verify magic bytes match declared MIME type
        const imageValidation = validateImageAttachment(attachment);
        if (!imageValidation.valid) {
          loggers.api.warn('Feedback attachment validation failed', {
            userId,
            fileName: attachment.name,
            declaredType: attachment.type,
            error: imageValidation.error,
          });
          return Response.json({
            error: imageValidation.error || `Invalid attachment: ${attachment.name}`
          }, { status: 400 });
        }
      }
      if (totalSize > MAX_TOTAL_SIZE) {
        return Response.json({
          error: 'Total attachment size exceeds 25MB limit'
        }, { status: 400 });
      }
    }

    // Store feedback in database with attachments
    const feedbackId = createId();
    await db.insert(feedbackSubmissions).values({
      id: feedbackId,
      userId,
      message,
      attachments: attachments || null,
      pageUrl: context?.pageUrl || null,
      userAgent: context?.userAgent || null,
      screenSize: context?.screenSize || null,
      viewportSize: context?.viewportSize || null,
      appVersion: context?.appVersion || null,
      consoleErrors: context?.consoleErrors || null,
    });

    loggers.api.info('Feedback submission received', {
      feedbackId,
      userId,
      hasAttachments: !!attachments?.length,
      pageUrl: context?.pageUrl,
    });

    return Response.json({
      message: 'Feedback submitted successfully. Thank you!'
    }, { status: 201 });

  } catch (error) {
    loggers.api.error('Feedback submission error', error as Error);
    return Response.json({
      error: 'An unexpected error occurred. Please try again later.'
    }, { status: 500 });
  }
}
