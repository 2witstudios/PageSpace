import { MIN_SERVER_API_VERSION } from '../version.js';
import type { ClientConfig, RequestDescriptor, TransportOperation } from './types.js';

const PATH_PARAM_PATTERN = /:([A-Za-z0-9_]+)/g;

/** Names of the `:param` segments in an operation path template, in order. */
export function extractPathParamNames(path: string): string[] {
  return [...path.matchAll(PATH_PARAM_PATTERN)].map((match) => match[1]!);
}

/**
 * Interpolates `:param` segments from `input`, URL-encoding each value so a
 * literal `/` or unicode in a param can never smuggle in an extra path
 * segment. Returns the resolved path plus the set of input keys it consumed,
 * so the caller can serialize the remainder as query/body.
 */
export function interpolatePath(
  path: string,
  input: Readonly<Record<string, unknown>>,
  operation: string,
): { path: string; consumed: ReadonlySet<string> } {
  const consumed = new Set<string>();
  const resolved = path.replace(PATH_PARAM_PATTERN, (_match, name: string) => {
    const value = input[name];
    if (value === undefined || value === null) {
      throw new TypeError(`Operation "${operation}" is missing path parameter "${name}"`);
    }
    consumed.add(name);
    return encodeURIComponent(String(value));
  });
  return { path: resolved, consumed };
}

/** Serializes a plain object as a query string with a stable (sorted) key order. */
function serializeQuery(params: Readonly<Record<string, unknown>>): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        search.append(key, String(item));
      }
      continue;
    }
    search.append(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

/**
 * Serializes a plain object as JSON with a stable (sorted) top-level key
 * order. Rebuilds the object with keys inserted in sorted order rather than
 * passing the sorted-keys array as `JSON.stringify`'s replacer — a replacer
 * array is an allow-list applied at every nesting level, so it would also
 * silently strip properties from nested objects/array-of-object fields
 * (e.g. `editSheetCells`'s `cells: [{address, value}]`) whose keys aren't
 * themselves top-level field names.
 */
function serializeBody(fields: Readonly<Record<string, unknown>>): string | undefined {
  const keys = Object.keys(fields).sort();
  if (keys.length === 0) return undefined;
  const ordered: Record<string, unknown> = {};
  for (const key of keys) {
    ordered[key] = fields[key];
  }
  return JSON.stringify(ordered);
}

/**
 * Pure: operation descriptor + validated input + client config → request
 * descriptor. No fetch, no clock, no randomness. Input's path-param fields
 * are interpolated into the URL; everything else becomes query params (GET)
 * or a JSON body (all other methods). Never sees or emits a token/Authorization
 * header — that is the facade's job (task 6), attached from the AuthProvider.
 */
export function buildRequest<TOutput>(
  op: TransportOperation<TOutput>,
  input: Readonly<Record<string, unknown>>,
  config: ClientConfig,
): RequestDescriptor {
  const { path, consumed } = interpolatePath(op.path, input, op.name);

  const remaining: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!consumed.has(key)) remaining[key] = input[key];
  }

  const isGet = op.method === 'GET';
  const query = isGet ? serializeQuery(remaining) : '';
  const body = isGet ? undefined : serializeBody(remaining);

  const headers: Record<string, string> = {
    // Declares the contract floor this SDK build requires (ADR 0001 D3);
    // the server's compatibility response header is a separate concern
    // verified by the facade, not built here.
    'X-PageSpace-API-Version': config.apiVersion ?? MIN_SERVER_API_VERSION,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  return {
    method: op.method,
    url: `${config.baseUrl}${path}${query}`,
    headers,
    body,
  };
}
