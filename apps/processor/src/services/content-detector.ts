import path from 'path';
import fs from 'fs/promises';
import { MagikaNode as Magika } from 'magika/node';
import { processorLogger } from '../logger';

export type DetectionSource = 'magika' | 'fallback';

export interface DetectedContentType {
  label: string;
  mimeType: string;
  score: number;
  source: DetectionSource;
}

const DETECTION_TIMEOUT_MS = 250;
const INIT_RETRY_BACKOFF_MS = 60_000;

const MODEL_DIR = path.resolve(__dirname, '../../assets/magika/standard_v3_3');
const MODEL_PATH = path.join(MODEL_DIR, 'model.json');
const MODEL_CONFIG_PATH = path.join(MODEL_DIR, 'config.min.json');

// magika/node's JS API only exposes { label, is_text } on prediction.output —
// no mime_type, no group. We map the labels the downstream ingest worker
// actually branches on (image/*, PDF, Office docs, plain text) to the MIME
// types its router expects. Labels not in this table fall through to
// application/octet-stream and get the "unsupported → visual" path.
const LABEL_TO_MIME: Readonly<Record<string, string>> = Object.freeze({
  // images — keep in sync with queue-manager's `mimeType.startsWith('image/')` branch
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heif: 'image/heif',
  ico: 'image/vnd.microsoft.icon',
  // text-extractable — keep in sync with workers/text-extractor.ts#needsTextExtraction
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
});

export const FALLBACK_DETECTION: DetectedContentType = Object.freeze({
  label: 'unknown',
  mimeType: 'application/octet-stream',
  score: 0,
  source: 'fallback',
});

let instancePromise: Promise<Magika> | null = null;
let lastInitFailureAt = 0;

async function getInstance(): Promise<Magika | null> {
  if (instancePromise) {
    return instancePromise;
  }
  // Backoff so a hot upload loop can't retry init thousands of times per second
  // when Magika.create() is failing. Successful loads cache forever.
  if (Date.now() - lastInitFailureAt < INIT_RETRY_BACKOFF_MS) {
    return null;
  }
  const attempt = Magika.create({
    modelPath: MODEL_PATH,
    modelConfigPath: MODEL_CONFIG_PATH,
  });
  instancePromise = attempt;
  try {
    return await attempt;
  } catch (err) {
    processorLogger.error(
      'magika init failed',
      err instanceof Error ? err : null,
    );
    instancePromise = null;
    lastInitFailureAt = Date.now();
    return null;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error('magika timeout')), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (handle) clearTimeout(handle);
  });
}

interface MagikaOutput {
  label?: string;
}

interface MagikaPrediction {
  output?: MagikaOutput;
  score?: number;
}

interface MagikaResultShape {
  prediction?: MagikaPrediction;
}

function mapResult(raw: MagikaResultShape | null | undefined): DetectedContentType {
  const output = raw?.prediction?.output;
  if (!output || typeof output.label !== 'string' || output.label.length === 0) {
    return FALLBACK_DETECTION;
  }
  return {
    label: output.label,
    mimeType: LABEL_TO_MIME[output.label] || 'application/octet-stream',
    score: typeof raw?.prediction?.score === 'number' ? raw.prediction.score : 0,
    source: 'magika',
  };
}

export async function detectContentType(filePath: string): Promise<DetectedContentType> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch (err) {
    processorLogger.warn('content-detector could not read file', {
      tempPath: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_DETECTION;
  }

  try {
    const magika = await getInstance();
    if (!magika) return FALLBACK_DETECTION;

    const raw = (await withTimeout(
      magika.identifyBytes(new Uint8Array(bytes)),
      DETECTION_TIMEOUT_MS,
    )) as MagikaResultShape;
    return mapResult(raw);
  } catch (err) {
    processorLogger.warn('content-detector classify failed', {
      tempPath: filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_DETECTION;
  }
}

/** test-only helper: drops the memoised singleton and clears any backoff window */
export function __resetContentDetectorForTests(): void {
  instancePromise = null;
  lastInitFailureAt = 0;
}
