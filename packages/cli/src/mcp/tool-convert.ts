/**
 * registry entry -> MCP tool definition (Phase 6 task 1). PURE: no I/O, no
 * SDK/network calls — every function here is a total, side-effect-free
 * transform over a single `Operation` and, where relevant, an already-thrown
 * SDK error value.
 *
 * JSON Schema conversion uses zod's own native `z.toJSONSchema` (zod v4),
 * not the third-party `zod-to-json-schema` package: verified directly
 * against zod 4.3.6 (this workspace's resolved version) that the
 * third-party package silently returns an empty `{ $schema }` for every
 * registry operation — it does not understand zod v4's internal schema
 * representation. `z.toJSONSchema` was verified against every schema
 * construct the registry actually uses: top-level and nested `.refine()`/
 * `.strict()`, optional/nullable fields, enums, literals-with-`.default()`,
 * arrays of objects, and string/number bounds (min/max/regex).
 */
import { z } from 'zod';
import {
  isAuthenticationError,
  isHttpError,
  isIncompatibleServerError,
  isNetworkError,
  isNotFoundError,
  isPageSpaceError,
  isPermissionDeniedError,
  isRateLimitError,
  isResponseValidationError,
  isServerError,
  isTimeoutError,
  isValidationError,
  type Operation,
} from '@pagespace/sdk';

export interface McpJsonSchema {
  readonly type: 'object';
  readonly [key: string]: unknown;
}

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpJsonSchema;
  readonly annotations: McpToolAnnotations;
}

export interface McpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface McpCallResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

export type ValidatedToolInput =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly string[] };

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(['GET']);

function textResult(text: string, isError = false): McpCallResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/**
 * Pure: `Operation` -> MCP tool definition. `op.description` is mandatory by
 * registry contract (`registry/define.ts`), so this never falls back to a
 * placeholder description.
 */
export function operationToMcpTool(op: Operation): McpToolDefinition {
  const schema = z.toJSONSchema(op.inputSchema) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = schema;

  return Object.freeze({
    name: op.name,
    description: op.description,
    inputSchema: Object.freeze({ type: 'object', ...rest }) as McpJsonSchema,
    annotations: Object.freeze({
      readOnlyHint: READ_ONLY_METHODS.has(op.method),
      destructiveHint: op.destructive === true,
    }),
  });
}

/** Pure: zod-validates `rawInput` against `op.inputSchema` — the mandatory pre-flight before any network call. */
export function validateToolInput(op: Operation, rawInput: unknown): ValidatedToolInput {
  const parsed = op.inputSchema.safeParse(rawInput);
  if (parsed.success) {
    return { ok: true, data: parsed.data as Record<string, unknown> };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`),
  };
}

/** Pure, MCP-conformant: invalid input is a normal tool result with `isError: true`, never a protocol-level crash. */
export function formatInvalidInputResult(op: Operation, issues: readonly string[]): McpCallResult {
  return textResult(`Invalid input for tool "${op.name}":\n${issues.map((issue) => `- ${issue}`).join('\n')}`, true);
}

/** Pure: an unrecognized tool name is a normal error result, never a thrown protocol error. */
export function formatUnknownToolResult(name: string): McpCallResult {
  return textResult(`Unknown tool: "${name}"`, true);
}

/** Pure: renders a successful operation output as MCP text content. */
export function formatSuccessResult(output: unknown): McpCallResult {
  return textResult(JSON.stringify(output, null, 2));
}

/**
 * Pure: maps an SDK typed error (or anything else a call might throw) to a
 * distinct, secret-free MCP error result. Every branch builds its message
 * from an error's own typed fields via the SDK's realm-independent guards —
 * never from `error.stack` or a raw dump of the error/request. The final,
 * unrecognized-error branch is deliberately generic: it does not surface
 * `error.message` at all, since a non-`PageSpaceError` throw could be
 * anything (the old api.js body/token stderr-logging pattern this phase's
 * law bans).
 */
export function formatSdkErrorResult(op: Operation, error: unknown): McpCallResult {
  if (isPermissionDeniedError(error)) {
    const scope = op.requiredScope ? ` Requires "${op.requiredScope}" scope.` : '';
    return textResult(`Permission denied for "${op.name}".${scope}`, true);
  }
  if (isAuthenticationError(error)) {
    return textResult(`Authentication failed for "${op.name}". Run "pagespace login" or set PAGESPACE_TOKEN.`, true);
  }
  if (isNotFoundError(error)) {
    return textResult(`Not found: the target of "${op.name}" does not exist or is not accessible.`, true);
  }
  if (isValidationError(error)) {
    return textResult(`Server rejected input for "${op.name}": ${error.message}`, true);
  }
  if (isRateLimitError(error)) {
    return textResult(`Rate limited calling "${op.name}". Try again later.`, true);
  }
  if (isResponseValidationError(error)) {
    return textResult(`Server response for "${op.name}" did not match the expected shape.`, true);
  }
  if (isIncompatibleServerError(error)) {
    return textResult(`Server is incompatible with this client for "${op.name}".`, true);
  }
  if (isTimeoutError(error)) {
    return textResult(`Timed out calling "${op.name}".`, true);
  }
  if (isNetworkError(error)) {
    return textResult(`Network error calling "${op.name}".`, true);
  }
  if (isServerError(error) || isHttpError(error)) {
    return textResult(`Server error calling "${op.name}": ${error.message}`, true);
  }
  if (isPageSpaceError(error)) {
    return textResult(`Error calling "${op.name}": ${error.message}`, true);
  }
  return textResult(`Unexpected error calling "${op.name}".`, true);
}
