/**
 * Reads a FILE page's stored bytes (a cache preset such as `ai-vision` or
 * `pdf-page-3`, or the `original` upload) through the processor's
 * `/cache/:hash/:preset` route.
 *
 * Going through the processor rather than reading S3 directly keeps decryption
 * (FILE_ENCRYPTION_ENABLED) and file authorization in one place: the processor
 * decrypts the envelope and re-checks the page-scoped service token against the
 * file. A raw S3 read returns ciphertext when encryption at rest is on.
 *
 * Pure of server-only imports so it can be unit tested; the runtime wiring
 * (centralized permission check, service-token mint) lives in
 * processor-file-fetch-runtime.ts.
 */

const CONTENT_HASH = /^[0-9a-f]{64}$/i;
// Mirrors the processor's isValidPreset (apps/processor/src/cache/content-store.ts).
const SAFE_PRESET = /^[a-zA-Z0-9_.-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

export class FileAccessDeniedError extends Error {
  constructor() {
    super('Insufficient permissions to read this file');
    this.name = 'FileAccessDeniedError';
  }
}

export interface FetchPresetOptions {
  /** Bytes over this are not returned (null). Checked against Content-Length first, then the body. */
  maxBytes?: number;
}

export type FetchPresetBytes = (
  contentHash: string,
  preset: string,
  options?: FetchPresetOptions,
) => Promise<Buffer | null>;

export interface ProcessorCacheFetcherDeps {
  /** The centralized permission check for the page. Runs once, before any token is minted. */
  canView: () => Promise<boolean>;
  /** Mints a page-scoped `files:read` service token for the processor. Runs once. */
  mintToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
  processorUrl?: string;
  timeoutMs?: number;
}

export function createProcessorCacheFetcher(deps: ProcessorCacheFetcherDeps): FetchPresetBytes {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const processorUrl = deps.processorUrl ?? process.env.PROCESSOR_URL ?? 'http://processor:3003';
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // One check and one token for every preset this fetcher reads (a page-image
  // read asks for several). The fetcher is built per tool call, so a denial or
  // a failed mint is only reused within that call.
  let tokenPromise: Promise<string> | null = null;
  const token = (): Promise<string> => {
    tokenPromise ??= (async () => {
      if (!(await deps.canView())) throw new FileAccessDeniedError();
      return deps.mintToken();
    })();
    return tokenPromise;
  };

  return async (contentHash, preset, options = {}) => {
    if (!CONTENT_HASH.test(contentHash)) throw new Error('Invalid content hash');
    if (!SAFE_PRESET.test(preset) || preset.includes('..')) throw new Error('Invalid preset name');

    const bearer = await token();
    const response = await fetchImpl(`${processorUrl}/cache/${contentHash}/${preset}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 404: no such preset. 410: the file was taken down. Both mean "nothing to show".
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Processor returned ${response.status} for preset ${preset}`);
    }

    const { maxBytes } = options;
    const declared = Number(response.headers.get('Content-Length'));
    if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (maxBytes !== undefined && bytes.length > maxBytes) return null;
    return bytes;
  };
}
