import {
  authenticateRequestWithOptions,
  isAuthError,
} from '@/lib/auth';
import { resolveAgentModel, type ResolvedAgentPage } from './model-resolver';
import type { OpenAIErrorBody } from './request-adapter';

export interface InferenceContext {
  userId: string;
  pageId: string;
  page: ResolvedAgentPage;
}

export type InferenceContextResult =
  | { ok: true; context: InferenceContext }
  | { ok: false; status: number; error: OpenAIErrorBody };

const openAIError = (
  status: number,
  message: string,
  code: string,
): InferenceContextResult => ({
  ok: false,
  status,
  error: { message, type: 'invalid_request_error', code },
});

export const resolveInferenceContext = async (
  request: Request,
  model: string,
): Promise<InferenceContextResult> => {
  const auth = await authenticateRequestWithOptions(request, {
    allow: ['mcp'],
    requireCSRF: false,
  });

  if (isAuthError(auth)) {
    return openAIError(
      401,
      'Invalid or missing API key. Provide a PageSpace MCP token as a Bearer token.',
      'invalid_api_key',
    );
  }

  const resolution = await resolveAgentModel(model);
  if (!resolution.ok) {
    return openAIError(resolution.status, resolution.message, resolution.code);
  }

  const allowedDriveIds =
    auth.tokenType === 'mcp' ? auth.allowedDriveIds : [];
  const driveId = resolution.page.driveId;

  if (
    allowedDriveIds.length > 0 &&
    (!driveId || !allowedDriveIds.includes(driveId))
  ) {
    return openAIError(
      403,
      `The model '${model}' is outside this API key's drive scope.`,
      'permission_denied',
    );
  }

  return {
    ok: true,
    context: {
      userId: auth.userId,
      pageId: resolution.pageId,
      page: resolution.page,
    },
  };
};
