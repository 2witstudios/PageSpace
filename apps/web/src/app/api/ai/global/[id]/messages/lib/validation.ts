import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { validateUserMessageFileParts, hasFileParts } from '@/lib/ai/core/validate-image-parts';
import { hasVisionCapability } from '@/lib/ai/core/model-capabilities';
import type { UIMessage } from 'ai';
import type { PostRequestBody, GetRequestPagination, GetRequestContext, ValidatedContext, PostRequestValidation } from './types';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

const MAX_BODY_SIZE = 25 * 1024 * 1024;

export async function validateReadAuth(request: Request): Promise<{ userId: string } | Response> {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  return { userId: auth.userId };
}

export async function validateWriteAuth(request: Request): Promise<{ userId: string } | Response> {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    loggers.api.debug('Global Assistant Chat API: Authentication failed', {});
    return auth.error;
  }
  return { userId: auth.userId };
}

export function validateBodySize(request: Request): Response | null {
  const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_BODY_SIZE) {
    loggers.api.warn('Global Assistant Chat API: Request body too large', { contentLength });
    return NextResponse.json({ error: 'Request body too large (max 25MB)' }, { status: 413 });
  }
  return null;
}

export async function parsePostBody(request: Request): Promise<PostRequestBody> {
  return request.json();
}

export function validatePostRequest(
  body: PostRequestBody,
  conversationId: string
): PostRequestValidation | Response {
  const { messages: requestMessages, selectedModel, isReadOnly, webSearchEnabled } = body;

  if (!requestMessages || requestMessages.length === 0) {
    loggers.api.debug('Global Assistant Chat API: No messages provided', {});
    return NextResponse.json({ error: 'messages are required' }, { status: 400 });
  }

  const userMessage = requestMessages[requestMessages.length - 1];

  if (userMessage?.role === 'user' && hasFileParts(userMessage)) {
    const imageValidation = validateUserMessageFileParts(userMessage);
    if (!imageValidation.valid) {
      loggers.api.warn('Global Assistant Chat API: Image validation failed', { error: imageValidation.error });
      return NextResponse.json({ error: imageValidation.error }, { status: 400 });
    }

    if (selectedModel && !hasVisionCapability(selectedModel)) {
      loggers.api.warn('Global Assistant Chat API: Images sent to non-vision model', { model: selectedModel });
      return NextResponse.json(
        { error: `The selected model "${selectedModel}" does not support image attachments. Please choose a vision-capable model.` },
        { status: 400 }
      );
    }
  }

  loggers.api.debug('Global Assistant Chat API: Validation passed', {
    messageCount: requestMessages.length,
    conversationId
  });

  return {
    body,
    userMessage,
    conversationId,
    readOnlyMode: isReadOnly === true,
    webSearchMode: webSearchEnabled === true,
  };
}

export function parseGetPagination(request: Request): GetRequestPagination {
  const { searchParams } = new URL(request.url);
  const limit = parseBoundedIntParam(searchParams.get('limit'), {
    defaultValue: 50,
    min: 1,
    max: 200,
  });
  const cursor = searchParams.get('cursor');
  const direction = (searchParams.get('direction') || 'before') as 'before' | 'after';

  return { limit, cursor, direction };
}

export function createAuthErrorResponse(error: string, status: number = 401): Response {
  return NextResponse.json({ error }, { status });
}

export function createNotFoundResponse(resource: string): Response {
  return NextResponse.json({ error: `${resource} not found` }, { status: 404 });
}

export function createErrorResponse(error: string, status: number = 500): Response {
  return NextResponse.json({ error }, { status });
}
