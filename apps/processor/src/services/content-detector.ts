import path from 'path';
import fs from 'fs/promises';
import { MagikaNode as Magika } from 'magika/node';
import { processorLogger } from '../logger';

export type DetectionSource = 'magika' | 'fallback';

export interface DetectedContentType {
  label: string;
  mimeType: string;
  group: string;
  score: number;
  source: DetectionSource;
}

const DETECTION_TIMEOUT_MS = 250;

const MODEL_DIR = path.resolve(__dirname, '../../assets/magika/standard_v3_3');
const MODEL_PATH = path.join(MODEL_DIR, 'model.json');
const MODEL_CONFIG_PATH = path.join(MODEL_DIR, 'config.min.json');

export const FALLBACK_DETECTION: DetectedContentType = Object.freeze({
  label: 'unknown',
  mimeType: 'application/octet-stream',
  group: 'unknown',
  score: 0,
  source: 'fallback',
});

let instancePromise: Promise<Magika | null> | null = null;

async function getInstance(): Promise<Magika | null> {
  if (!instancePromise) {
    instancePromise = (async () => {
      try {
        return await Magika.create({
          modelPath: MODEL_PATH,
          modelConfigPath: MODEL_CONFIG_PATH,
        });
      } catch (err) {
        processorLogger.error(
          'magika init failed',
          err instanceof Error ? err : null,
        );
        return null;
      }
    })();
  }
  return instancePromise;
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
  mime_type?: string;
  group?: string;
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
    mimeType: output.mime_type || 'application/octet-stream',
    group: output.group || 'unknown',
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

/** test-only helper: drops the memoised singleton */
export function __resetContentDetectorForTests(): void {
  instancePromise = null;
}
