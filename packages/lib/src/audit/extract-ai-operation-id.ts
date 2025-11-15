/**
 * Utility to extract AI operation ID from request headers
 *
 * When AI tools call API routes, they can pass the AI operation ID via the
 * `x-ai-operation-id` header. This allows API routes to link their audit
 * events to the parent AI operation.
 *
 * @example
 * ```typescript
 * // In an API route handler
 * import { extractAiOperationId } from '@pagespace/lib/audit';
 *
 * export async function POST(request: Request) {
 *   const aiOperationId = extractAiOperationId(request);
 *
 *   // Create audit event with AI operation link
 *   await createAuditEvent({
 *     // ...
 *     aiOperationId, // Link to parent AI operation
 *     isAiAction: !!aiOperationId,
 *   });
 * }
 * ```
 */

/**
 * Header name for AI operation ID
 */
export const AI_OPERATION_ID_HEADER = 'x-ai-operation-id';

/**
 * Extracts AI operation ID from request headers
 *
 * @param request - The incoming HTTP request
 * @returns AI operation ID if present, undefined otherwise
 */
export function extractAiOperationId(request: Request): string | undefined {
  const aiOperationId = request.headers.get(AI_OPERATION_ID_HEADER);
  return aiOperationId || undefined;
}

/**
 * Checks if a request originated from an AI agent
 *
 * @param request - The incoming HTTP request
 * @returns true if the request has an AI operation ID header
 */
export function isAiInitiatedRequest(request: Request): boolean {
  return !!request.headers.get(AI_OPERATION_ID_HEADER);
}
