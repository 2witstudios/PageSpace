import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@pagespace/db', () => ({
  db: {},
  pages: { id: 'id' },
  eq: vi.fn(),
}));

import { FileProcessor } from '../file-processor';

type VisionResult = {
  success: boolean;
  content: string;
  metadata: { method: string; status?: string; [key: string]: unknown };
  error?: string;
};

type PrivateVisionMethod = {
  extractWithAIVision(buffer: Buffer, mimeType: string, pageId: string): Promise<VisionResult>;
};

function callExtractWithAIVision(
  processor: FileProcessor,
  buffer: Buffer,
  mimeType: string,
  pageId: string,
): Promise<VisionResult> {
  const impl = (processor as unknown as PrivateVisionMethod).extractWithAIVision.bind(processor);
  return impl(buffer, mimeType, pageId);
}

describe('FileProcessor AI vision env vars', () => {
  const originalFetch = global.fetch;
  const keys = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'OPENROUTER_DEFAULT_API_KEY',
  ] as const;
  const saved: Partial<Record<(typeof keys)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns no-api-keys when no vision provider env vars are set', async () => {
    const processor = new FileProcessor();
    const result = await callExtractWithAIVision(processor, Buffer.from(''), 'image/png', 'page-1');

    expect(result.success).toBe(false);
    expect(result.metadata.status).toBe('no-api-keys');
  });

  it('treats OPENROUTER_DEFAULT_API_KEY as a configured OpenRouter key', async () => {
    process.env.OPENROUTER_DEFAULT_API_KEY = 'sk-or-v1-test';

    const processor = new FileProcessor();
    const result = await callExtractWithAIVision(processor, Buffer.from(''), 'image/png', 'page-1');

    expect(result.metadata.status).not.toBe('no-api-keys');
  });

  it('does not treat the deprecated OPENROUTER_API_KEY as a configured key', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-old';

    const processor = new FileProcessor();
    const result = await callExtractWithAIVision(processor, Buffer.from(''), 'image/png', 'page-1');

    expect(result.metadata.status).toBe('no-api-keys');
  });
});
