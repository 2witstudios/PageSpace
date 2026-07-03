/**
 * Operation registry — the load-bearing abstraction (Phase 2 task 5).
 *
 * `defineOperation` is the single place an operation's method, path, and
 * zod schemas are declared; SDK resource methods (Phase 3), CLI verbs
 * (Phase 5), and MCP tool definitions (Phase 6) are all derived from the
 * `Operation` values it produces. Path interpolation reuses task 3's pure
 * `buildRequest`/`parseResponse` core (`Operation` extends `TransportOperation`
 * unchanged) — this module never reimplements it.
 */
import type { z } from 'zod';
import type { HttpMethod } from '../transport/types.js';

/**
 * Scope required to invoke this operation, per ADR 0002's grammar
 * (docs/adr/0002-oauth-scope-grammar.md Decision 1). Excludes the specific
 * driveId (bound per-call from the operation's own path params, not the
 * definition) and the custom-role variant (a role id is a per-grant value,
 * not a per-operation constant) — this is the minimum drive relationship
 * the CLI/MCP layers need to pre-flight a permission error before the
 * network layer, not a full scope grant.
 */
export type RequiredScope = 'account' | 'drive' | 'drive:admin' | 'drive:member';

/** Names of the `:param` segments in a path template, as a type-level union. */
export type PathParamNames<TPath extends string> = TPath extends `${string}:${infer Param}/${infer Rest}`
  ? Param | PathParamNames<Rest>
  : TPath extends `${string}:${infer Param}`
    ? Param
    : never;

export interface OperationConfig<
  TPath extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
> {
  readonly name: string;
  readonly method: HttpMethod;
  /** Template path with `:paramName` segments, e.g. `/api/drives/:driveId/pages`. */
  readonly path: TPath;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly requiredScope?: RequiredScope;
  /** Set for export-style operations whose 2xx body is raw text, not JSON. */
  readonly textResponse?: boolean;
  /**
   * Overrides the client's default request timeout for this operation only
   * (e.g. `agents.ask`, whose consult loop can run up to 20 tool-calling
   * steps). Facade-enforced (client.ts `#invoke`); absent, the client's own
   * `timeoutMs` applies.
   */
  readonly timeoutMsOverride?: number;
  /**
   * Marks a non-idempotent operation whose effect is destructive/irreversible
   * (deletes a resource, prunes a grant). The CLI layer (Phase 5) requires
   * `--yes` before invoking any operation with this flag set; `isIdempotentMethod`
   * (retry.ts) already blocks auto-retry for these methods, so this is purely a
   * confirmation-gate signal, not a retry-safety one.
   */
  readonly destructive?: boolean;
  /** Mandatory: becomes the MCP tool description in Phase 6. */
  readonly description: string;
}

/**
 * Compile-time check that every `:param` in `path` has a matching field in
 * `inputSchema`'s inferred type. On failure, adds a `__missingPathParams`
 * property naming the offenders so the error surfaces at the call site.
 */
export type ValidOperationConfig<
  TPath extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
> = [PathParamNames<TPath>] extends [keyof z.infer<TInputSchema>]
  ? OperationConfig<TPath, TInputSchema, TOutputSchema>
  : OperationConfig<TPath, TInputSchema, TOutputSchema> & {
      readonly __missingPathParams: Exclude<PathParamNames<TPath>, keyof z.infer<TInputSchema>>;
    };

/**
 * Structurally compatible with `TransportOperation<z.infer<TOutputSchema>>`
 * (task 3) by field shape, not a formal `extends` — a generic `extends`
 * across zod's invariant `ZodType<Output, Input>` params does not typecheck
 * for an abstract `TOutputSchema`, only for the concrete schema each real
 * operation supplies. `buildRequest`/`parseResponse` accept any `Operation`
 * unchanged.
 */
export interface Operation<
  TPath extends string = string,
  TInputSchema extends z.ZodType = z.ZodType,
  TOutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly method: HttpMethod;
  readonly path: TPath;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly requiredScope: RequiredScope | undefined;
  readonly textResponse: boolean | undefined;
  readonly timeoutMsOverride: number | undefined;
  readonly destructive: boolean | undefined;
  readonly description: string;
}

/** Pure: an operation config in, an immutable `Operation` value out. Never throws. */
export function defineOperation<
  TPath extends string,
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
>(
  config: ValidOperationConfig<TPath, TInputSchema, TOutputSchema>,
): Operation<TPath, TInputSchema, TOutputSchema> {
  const {
    name,
    method,
    path,
    inputSchema,
    outputSchema,
    requiredScope,
    textResponse,
    timeoutMsOverride,
    destructive,
    description,
  } = config as OperationConfig<TPath, TInputSchema, TOutputSchema>;

  return Object.freeze({
    name,
    method,
    path,
    inputSchema,
    outputSchema,
    requiredScope,
    textResponse,
    timeoutMsOverride,
    destructive,
    description,
  });
}
