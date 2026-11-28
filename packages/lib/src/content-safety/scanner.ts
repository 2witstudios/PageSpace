/**
 * Content scanner port — what the publish gate asks of a vendor, and nothing
 * vendor-specific. An adapter (scanner-hive.ts) maps one vendor's API onto this;
 * tests use `createFakeScanner`.
 *
 * A scanner never throws for an ordinary failure: a network error, a bad
 * response or a timeout comes back as `{ kind: 'error' }`, so the gate has one
 * shape to decide on. Adapters must never log the bytes, a URL or a response body.
 */

/** What can be sent to a scanner. Raster images and video only; everything else is `unsupported_type` before a call. */
export type ScanMediaKind = 'image' | 'video';

export interface ScanInput {
  /** Canonical sha256 of the bytes. Used to key the verdict, never sent to a vendor by the gate. */
  contentHash: string;
  mediaKind: ScanMediaKind;
  /** The content type the bytes are sent as (sniffed when possible, else declared). */
  contentType: string;
  bytes: Uint8Array;
}

export type ScanErrorReason = 'timeout' | 'network' | 'http_status' | 'bad_response' | 'vendor_status' | 'too_large' | 'not_configured' | 'unreadable_source';

export type ScanResult =
  | { kind: 'clean'; provider: string; scores?: Record<string, number> }
  /** The bytes match a list of known material. `lists` names the hash sets, never the match metadata. */
  | { kind: 'hash_match'; provider: string; lists: string[]; matchTypes: string[] }
  /** A classifier scored the bytes above the flag threshold. Not proof: a person reviews it. */
  | { kind: 'classifier_flag'; provider: string; category: string; score: number; scores?: Record<string, number> }
  | { kind: 'unsupported_type'; provider: string; contentType: string }
  | { kind: 'error'; provider: string; reason: ScanErrorReason; detail?: string };

export type ScanResultKind = ScanResult['kind'];

export interface ContentScanner {
  /** Stable provider name stored with every verdict, e.g. `hive`. */
  readonly provider: string;
  scan(input: ScanInput, options?: { signal?: AbortSignal }): Promise<ScanResult>;
}

/**
 * Run a scan with a deadline. A scan that outlasts it is aborted and reported as
 * `error/timeout`; a scanner that throws anyway (a bug) is reported as `error/network`.
 */
export async function scanWithTimeout(scanner: ContentScanner, input: ScanInput, timeoutMs: number): Promise<ScanResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ScanResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'error', provider: scanner.provider, reason: 'timeout' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      scanner.scan(input, { signal: controller.signal }).catch(
        (): ScanResult => (controller.signal.aborted
          ? { kind: 'error', provider: scanner.provider, reason: 'timeout' }
          : { kind: 'error', provider: scanner.provider, reason: 'network' }),
      ),
      timedOut,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * A scanner for tests: a result per content hash, a default for the rest, and a
 * record of every hash it was asked about. `delayMs` makes timeouts testable.
 */
export function createFakeScanner(options: {
  results?: Record<string, ScanResult | ((input: ScanInput) => ScanResult)>;
  defaultResult?: ScanResult;
  delayMs?: number;
  provider?: string;
} = {}): ContentScanner & { calls: string[] } {
  const provider = options.provider ?? 'fake';
  const calls: string[] = [];
  return {
    provider,
    calls,
    async scan(input, scanOptions) {
      calls.push(input.contentHash);
      if (options.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.delayMs);
          scanOptions?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          });
        });
      }
      const configured = options.results?.[input.contentHash];
      if (typeof configured === 'function') return configured(input);
      return configured ?? options.defaultResult ?? { kind: 'clean', provider };
    },
  };
}
