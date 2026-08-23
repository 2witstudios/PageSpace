/**
 * What a tool call says when it was made wrong.
 *
 * Both tool surfaces — `execute_tool` on the text stack and
 * `dispatchRealtimeToolCall` on voice — used to answer a bad call with a
 * POINTER: "call tool_search("select:name") to get the correct parameter
 * schema". The schema was already in hand at that exact line (it is what the
 * `safeParse` just ran against), so the pointer bought nothing and cost a
 * guaranteed extra round trip on every first-use parameter mistake. One real
 * session hit six of them in a row — `repoUrl` for `repo_url`, `pageId` for
 * `id`, `find`/`replace` for `oldString`/`newString`, `mergeMethod` for
 * `strategy` — each one a failed call, a `tool_search`, and only then the call
 * the model meant to make.
 *
 * So the schema goes in the error. The model corrects itself on the next call
 * with nothing in between.
 *
 * THE CEILING IS THE WHOLE DESIGN CONSTRAINT. An error is not a place to dump
 * an arbitrarily large payload: a tool result stays in the context window, and
 * some tool schemas are big enough that inlining one whole would cost more
 * context than the round trip it saves. `describeToolSchema` therefore never
 * returns more than `MAX_SCHEMA_CHARS`, degrading through progressively
 * cheaper renderings — full JSON Schema, then a one-line-per-parameter
 * outline, then a truncated outline — and SAYS which one the reader got, so a
 * summarised schema is never mistaken for the complete one.
 */

import { z } from 'zod';

/**
 * How much of one schema an error may carry.
 *
 * ~1k tokens. Sized so the common case — every PageSpace tool schema measured
 * at the time of writing, the largest of which serializes to well under this —
 * arrives whole, while a pathological schema (a deeply nested union, an MCP
 * tool from someone else's server) degrades instead of flooding the context.
 * Deliberately far below the voice surface's `MAX_RESULT_CHARS` (12k), which
 * bounds a whole tool RESULT: an error is not allowed to be the largest thing
 * in the conversation.
 */
export const MAX_SCHEMA_CHARS = 4_000;

/**
 * How much of zod's own message an error may carry.
 *
 * The message is a JSON array with one entry per ISSUE, so its length is set
 * by what the CALLER sent against what the tool wants, not by the tool alone:
 * a call that omits two hundred required fields produces two hundred entries.
 * (Unrecognized keys are the cheap case — zod bundles them into one issue.)
 * Bounding the schema while leaving this unbounded would move the context
 * blowout rather than fix it, so the tail is cut; the leading issues are the
 * informative ones, because they name the keys that were wrong.
 */
const MAX_VALIDATION_CHARS = 2_000;

/** How many near-miss names an unknown-tool error offers. */
const MAX_SUGGESTIONS = 3;

/**
 * Longest name `suggestToolNames` will run its edit-distance pass over.
 *
 * THE NAME IS MODEL-CONTROLLED AND UNBOUNDED. `execute_tool` declares
 * `tool_name: z.string()` and the voice bridge declares `name: z.string().min(1)`
 * — neither carries a `.max()`, so the string that lands here is whatever the
 * model emitted. Levenshtein is O(n·m), so a degenerate name (a model looping
 * on a repeated token, or one induced by page content) turns a formerly O(1)
 * error path into seconds of SYNCHRONOUS CPU — which blocks the Node event
 * loop for the whole web tier, not just that request. Measured before this
 * bound: a single 200,000-character name against ~200 candidates took 31
 * seconds.
 *
 * 128 is double the 64-character ceiling `mcp-tool-converter` enforces on any
 * real tool name, so nothing legitimate is turned away; past it there is no
 * near miss to find, only a bill to pay.
 */
const MAX_SUGGESTION_NAME_CHARS = 128;

/**
 * Longest tool name echoed back inside an error.
 *
 * The name is whatever the model emitted, and every message below quotes it —
 * twice, in the invalid-parameters case. Echoing it unclipped would make the
 * error as large as the caller chose to make it, which is the same unbounded
 * payload `MAX_SCHEMA_CHARS` exists to prevent, arriving by a different door.
 * (The old messages echoed it unclipped too; the difference is that the bound
 * is now claimed, so it has to be true.) 96 is comfortably above the
 * 64-character ceiling any real tool name obeys.
 */
const MAX_TOOL_NAME_CHARS = 96;

/**
 * The longest an invalid-parameters error can be — the caps above plus the
 * two echoed tool names and the fixed framing around them. Exported so the
 * bound is asserted against a named number rather than a magic one.
 *
 * Declared after every cap it sums: a `const` initialised from a `const`
 * declared further down the module hits the temporal dead zone and throws on
 * import, which is a crash at load, not a test failure.
 */
export const MAX_PARAMETER_ERROR_CHARS =
  MAX_VALIDATION_CHARS + MAX_SCHEMA_CHARS + 2 * MAX_TOOL_NAME_CHARS + 200;

/** Longest description kept per parameter when a schema degrades to an outline. */
const MAX_OUTLINE_DESCRIPTION_CHARS = 80;

/**
 * Longest rendered TYPE kept per parameter in an outline.
 *
 * The outline's per-line budget check skips a line that will not fit, so the
 * overall cap holds either way — but one parameter with a 500-value enum would
 * otherwise render as a single multi-thousand-character line and crowd out
 * every other parameter name, which is exactly what the outline exists to
 * preserve. Clipping the type keeps the line list readable and roughly even.
 */
const MAX_OUTLINE_TYPE_CHARS = 120;

/**
 * The JSON Schema shape we read back out of `z.toJSONSchema`. Only the members
 * the outline needs are named; everything else passes through as JSON.
 */
type JsonSchemaLike = {
  readonly type?: unknown;
  readonly properties?: Record<string, JsonSchemaLike>;
  readonly required?: readonly string[];
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly anyOf?: readonly JsonSchemaLike[];
  readonly oneOf?: readonly JsonSchemaLike[];
  readonly items?: JsonSchemaLike;
};

/**
 * A tool's input schema, rendered for a model that just got it wrong, never
 * longer than `MAX_SCHEMA_CHARS`.
 *
 * `unrepresentable: 'any'` rather than the default `'throw'`, and `io: 'input'`
 * rather than the default `'output'`: this is describing what the CALLER must
 * send, and a schema with a transform or a branded type in it must still
 * produce something useful instead of exploding inside an error path. Cycles
 * become `$ref`s for the same reason — throwing here would replace a helpful
 * error with an unhelpful one.
 */
export function describeToolSchema(toolName: string, schema: unknown): string {
  // EVERY path that does not return a schema must hand back the lookup that
  // would. The prompt now tells the model a rejection carries the schema and
  // that it therefore need not run a `tool_search` — so a degraded rendering
  // with no pointer leaves it with neither, and it retries blind.
  const lookup = `Call tool_search("select:${clip(toolName, MAX_TOOL_NAME_CHARS)}") for the full schema.`;

  const json = toJsonSchema(schema);
  if (json === undefined) {
    // Nothing at all could be derived — a non-Zod `inputSchema`, or a
    // conversion that failed even in its most forgiving mode. Say so plainly;
    // a made-up schema would be worse than none.
    return `Parameter schema unavailable for this tool. ${lookup}`;
  }

  const full = safeStringify(json);
  if (full !== undefined && full.length <= MAX_SCHEMA_CHARS) return full;

  const outline = outlineParameters(json, lookup);
  if (outline === undefined) {
    return `Parameter schema is too large to include (over ${MAX_SCHEMA_CHARS} characters) and could not be summarised. ${lookup}`;
  }
  return outline;
}

/**
 * The line an invalid-parameters failure returns, on both surfaces.
 *
 * The validation errors come first because they name the specific keys that
 * were wrong, and the schema follows as the answer to "then what should they
 * have been". No `tool_search` hint: the payload that lookup would have
 * returned is already here.
 */
export function formatInvalidParametersError(
  toolName: string,
  schema: unknown,
  validationMessage: string
): string {
  const issues =
    validationMessage.length <= MAX_VALIDATION_CHARS
      ? validationMessage
      : `${validationMessage.slice(0, MAX_VALIDATION_CHARS)}… [further validation issues omitted]`;
  const name = clip(toolName, MAX_TOOL_NAME_CHARS);
  return [
    `Invalid parameters for "${name}". Validation errors: ${issues}`,
    `Input schema for "${name}": ${describeToolSchema(toolName, schema)}`,
  ].join('\n');
}

/**
 * The line an unknown-tool call returns.
 *
 * Suggestions are drawn from the names available to THIS caller, not from the
 * whole registry — offering a tool the agent's owner switched off would send
 * it into a "not permitted" error instead of a working call. When nothing is
 * close enough, `tool_search` is still the honest answer: there is no schema
 * to inline for a tool that does not exist.
 */
export function formatUnknownToolError(
  toolName: string,
  availableToolNames: readonly string[]
): string {
  const suggestions = suggestToolNames(toolName, availableToolNames);
  const name = clip(toolName, MAX_TOOL_NAME_CHARS);
  if (suggestions.length === 0) {
    return `Unknown tool "${name}". Call tool_search("keyword") to discover available tools.`;
  }
  return `Unknown tool "${name}". Did you mean: ${suggestions.join(', ')}? Otherwise call tool_search("keyword") to discover available tools.`;
}

/**
 * Names close enough to be what the caller meant, best first.
 *
 * The first rank is the one that actually bites in this codebase: the object
 * key in a tool module IS the wire name, and the sandbox tools are camelCase
 * (`readFile`, `writeFile`, `editFile`) while everything else is snake_case.
 * There is no mapping layer anywhere, so `read_file` is simply an unknown
 * tool — and normalising away case and separators turns that dead end into
 * the right answer. The second rank catches the rest of the near misses
 * (`git_log` vs `git_logs`, a forgotten prefix) by edit distance, scaled to
 * the name's length so short names are not matched to everything.
 */
export function suggestToolNames(
  toolName: string,
  availableToolNames: readonly string[]
): string[] {
  const target = normalizeToolName(toolName);
  if (target.length === 0 || target.length > MAX_SUGGESTION_NAME_CHARS) return [];

  const threshold = Math.max(1, Math.floor(target.length / 3));

  const scored: { name: string; rank: number; distance: number }[] = [];
  for (const name of availableToolNames) {
    const candidate = normalizeToolName(name);
    if (candidate === target) {
      scored.push({ name, rank: 0, distance: 0 });
      continue;
    }
    if (candidate.includes(target) || target.includes(candidate)) {
      scored.push({ name, rank: 1, distance: Math.abs(candidate.length - target.length) });
      continue;
    }
    // A length gap wider than the threshold cannot be closed by fewer edits
    // than the gap itself, so the distance is already known to be too big.
    // Skipping keeps the quadratic step off names that could never match.
    if (Math.abs(candidate.length - target.length) > threshold) continue;
    const distance = editDistance(target, candidate);
    if (distance <= threshold) {
      scored.push({ name, rank: 2, distance });
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.name);
}

/** Case and separators removed — `read_file`, `readFile` and `ReadFile` all collapse together. */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Standard Levenshtein distance, two rows at a time. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * `z.toJSONSchema` in its most forgiving configuration, or `undefined` if the
 * value is not a schema this can read at all.
 */
function toJsonSchema(schema: unknown): JsonSchemaLike | undefined {
  if (schema == null || typeof schema !== 'object') return undefined;
  try {
    return z.toJSONSchema(schema as z.ZodType, {
      io: 'input',
      unrepresentable: 'any',
      cycles: 'ref',
    }) as JsonSchemaLike;
  } catch {
    return undefined;
  }
}

/**
 * One line per top-level parameter, for a schema too big to inline whole.
 *
 * This keeps the part a mis-named-parameter error exists to deliver — the key
 * names, whether each is required, and enough of the type to fill it in — and
 * drops the part that made it big, which is always nesting. A nested object
 * collapses to `object`; the model that needs its interior can still ask for
 * the full schema, and the line says so.
 */
function outlineParameters(json: JsonSchemaLike, lookup: string): string | undefined {
  const properties = json.properties;
  if (properties === undefined) return undefined;

  const required = new Set(json.required ?? []);
  const entries = Object.entries(properties);
  const lines: string[] = [];
  let omitted = 0;
  let used = 0;

  // Reserve room for the trailing note before spending the budget on lines, so
  // the "N omitted" sentence can never itself push the result over the cap.
  const budget = MAX_SCHEMA_CHARS - OUTLINE_RESERVE;

  for (const [name, property] of entries) {
    const line = `  ${name}${required.has(name) ? '' : '?'}: ${clip(describeType(property), MAX_OUTLINE_TYPE_CHARS)}${describeSuffix(property)}`;
    if (used + line.length + 1 > budget) {
      omitted += 1;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }

  if (lines.length === 0) return undefined;

  const header = `Parameters (summarised — the full schema is over ${MAX_SCHEMA_CHARS} characters. ${lookup}):`;
  const footer = omitted > 0 ? `\n  …and ${omitted} more parameter(s) not shown.` : '';
  return `${clip(header, OUTLINE_RESERVE - 60)}\n${lines.join('\n')}${footer}`;
}

/**
 * Characters held back from the outline budget for its header and footer.
 *
 * The footer is fixed apart from a count, but the header now embeds the tool
 * name via the `tool_search` pointer — and the name is model-supplied on the
 * way in, so it is bounded here rather than assumed short. `outlineParameters`
 * clips the header to this reserve before emitting it, which is what keeps
 * `MAX_SCHEMA_CHARS` a real ceiling rather than one that holds for the names
 * we happened to test.
 */
const OUTLINE_RESERVE = 250;

/** A parameter's type as a short phrase: `string`, `"a" | "b"`, `string[]`, `object`. */
function describeType(property: JsonSchemaLike): string {
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    return property.enum.map((value) => JSON.stringify(value)).join(' | ');
  }
  const variants = property.anyOf ?? property.oneOf;
  if (variants !== undefined && variants.length > 0) {
    return variants.map(describeType).join(' | ');
  }
  if (property.type === 'array') {
    return `${property.items === undefined ? 'unknown' : describeType(property.items)}[]`;
  }
  if (typeof property.type === 'string') return property.type;
  if (Array.isArray(property.type)) return property.type.map(String).join(' | ');
  return 'unknown';
}

/** `text`, or its first `limit` characters with an ellipsis standing in for the rest. */
function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** The parameter's own description, clipped — it is the part most likely to be long. */
function describeSuffix(property: JsonSchemaLike): string {
  const description = property.description;
  if (typeof description !== 'string' || description.trim().length === 0) return '';
  const single = description.replace(/\s+/g, ' ').trim();
  return ` — ${clip(single, MAX_OUTLINE_DESCRIPTION_CHARS)}`;
}

/**
 * `JSON.stringify` THROWS on a circular structure and returns `undefined` for
 * a non-serializable root. A generated JSON Schema should be neither, but this
 * runs inside an error path and must not be the thing that fails.
 */
function safeStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value) ?? undefined;
  } catch {
    return undefined;
  }
}
