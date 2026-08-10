/**
 * The realtime session config and the two OpenAI endpoints a call touches.
 *
 * Shape verified against the OpenAI Realtime docs:
 * `POST /v1/realtime/client_secrets` takes `{ session: {...} }`, and tools are
 * flat `{ type: 'function', name, description, parameters }` entries — not
 * nested under a `function` key the way Chat Completions nests them.
 *
 * Pure: no I/O, no clock, no randomness, no module-level mutable state. Nothing
 * here reads `process.env` — the caller passes the env bag in.
 */

/**
 * Model access is per-account, and it fails LATE: `client_secrets` accepts any
 * model string and mints a secret, then `/v1/realtime/calls` 403s
 * `model_not_found` at connect time if the project lacks it. So mint success is
 * never proof of model access — surface model-config errors from the calls
 * response, not the mint response. (A plain `wss://…?model=X` socket opens even
 * for an unentitled model, so it is useless as a probe; `GET /v1/models` and
 * `/v1/realtime/calls` are the reliable signals.)
 *
 * `gpt-realtime-2.1` was not on this project until it was added to the
 * allowlist; `/v1/realtime/calls` now returns 201 for it, verified with a real
 * browser SDP offer. Override per-environment with OPENAI_REALTIME_MODEL rather
 * than editing this — a deployment whose project lacks 2.1 needs `gpt-realtime`.
 */
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
export const REALTIME_VOICE = 'marin';

/** The env var that overrides the model, named once so callers can't drift. */
export const REALTIME_MODEL_ENV_VAR = 'OPENAI_REALTIME_MODEL';

export type EnvBag = Readonly<Record<string, string | undefined>>;

/**
 * Pure env resolution: an unset, blank, or whitespace-only override is not an
 * override. Callers hand in `process.env` at the edge.
 */
export const resolveRealtimeModel = (env: EnvBag): string =>
  env[REALTIME_MODEL_ENV_VAR]?.trim() || DEFAULT_REALTIME_MODEL;

/**
 * A tool as the realtime transport carries it. This is the wire shape only —
 * PageSpace's own tool registry is the source of truth for which tools exist
 * and what they do, and maps into this type elsewhere.
 */
export type RealtimeTool = {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
};

export type SessionConfig = {
  readonly session: {
    readonly type: 'realtime';
    readonly model: string;
    readonly instructions?: string;
    readonly audio: { readonly output: { readonly voice: string } };
    readonly tools: readonly RealtimeTool[];
    readonly tool_choice: 'auto';
  };
};

export type SessionOptions = {
  readonly model?: string;
  readonly voice?: string;
  readonly instructions?: string;
  readonly tools?: readonly RealtimeTool[];
};

/**
 * The `client_secrets` request body. `instructions` is omitted rather than sent
 * empty when absent — an empty string is an instruction ("say nothing about
 * yourself"), not the absence of one.
 */
export const buildSessionConfig = (
  options: SessionOptions = {},
): SessionConfig => ({
  session: {
    type: 'realtime',
    model: options.model ?? DEFAULT_REALTIME_MODEL,
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
    audio: { output: { voice: options.voice ?? REALTIME_VOICE } },
    tools: options.tools ?? [],
    tool_choice: 'auto',
  },
});

/** Where the server mints the ephemeral secret. */
export const CLIENT_SECRETS_URL =
  'https://api.openai.com/v1/realtime/client_secrets';

/**
 * Where the browser POSTs its SDP offer once it holds an ephemeral secret. The
 * model is NOT passed here — it was fixed when the secret was minted.
 */
export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/** The SDP offer/answer content type `/v1/realtime/calls` speaks. */
export const SDP_CONTENT_TYPE = 'application/sdp';

/** The data channel the realtime event stream rides on. */
export const REALTIME_DATA_CHANNEL = 'oai-events';

/**
 * The mint response carries the secret under `value`. Narrow defensively —
 * a shape change should surface as a clear failure, not `undefined` on the wire.
 */
export const extractClientSecret = (payload: unknown): string | undefined => {
  if (typeof payload !== 'object' || payload === null) {
    return undefined;
  }
  const value = (payload as { value?: unknown }).value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};
