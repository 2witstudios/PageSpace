import { classifyHttpError, type HttpErrorHeaders, type PageSpaceError, ResponseValidationError, type ValidationIssue } from '../errors.js';
import type { TransportOperation } from './types.js';

/** Parses JSON when possible; on empty/malformed input, returns a value the schema will reject rather than throwing. */
function tryParseJson(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toValidationIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): ValidationIssue[] {
  return issues.map((issue) => ({
    path: issue.path.filter((segment): segment is string | number => typeof segment === 'string' || typeof segment === 'number'),
    message: issue.message,
  }));
}

export type ParsedResponse<TOutput> = TOutput | PageSpaceError;

/**
 * Pure: raw response parts → validated output or a classified error, as a
 * value (never thrown). Non-2xx statuses delegate to classifyHttpError
 * (task 2) before any schema is consulted — a proxy error page with no
 * recognizable body must still surface as a server/transport error.
 */
export function parseResponse<TOutput>(
  op: TransportOperation<TOutput>,
  status: number,
  headers: HttpErrorHeaders,
  bodyText: string,
): ParsedResponse<TOutput> {
  if (status < 200 || status > 299) {
    return classifyHttpError(status, headers, tryParseJson(bodyText), op.name);
  }

  if (op.textResponse) {
    return bodyText as TOutput;
  }

  const result = op.outputSchema.safeParse(tryParseJson(bodyText));
  if (result.success) {
    return result.data;
  }
  return new ResponseValidationError(op.name, toValidationIssues(result.error.issues));
}
