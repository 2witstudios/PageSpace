import { describe, it, vi, afterEach } from 'vitest';
import { assert } from '@/test/riteway';
import { getModelCapabilities } from '../model-capabilities';

// OpenRouter's tool metadata is fetched over the network; an empty list keeps the
// lookup offline (tools fall back to false for an unknown OpenRouter model).
const stubOpenRouter = () => vi.spyOn(globalThis, 'fetch').mockResolvedValue(
  new Response(JSON.stringify({ data: [] }), { status: 200 }),
);

describe('getModelCapabilities', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports native PDF input for Gemini via OpenRouter', async () => {
    stubOpenRouter();
    const caps = await getModelCapabilities('google/gemini-4-neon', 'google');
    assert({
      given: 'Gemini 4 Neon on the google (OpenRouter-backed) provider',
      should: 'report both vision and native PDF input',
      actual: { hasVision: caps.hasVision, hasPdfInput: caps.hasPdfInput },
      expected: { hasVision: true, hasPdfInput: true },
    });
  });

  it('reports vision without PDF input for GLM 5.3 Flash', async () => {
    stubOpenRouter();
    const caps = await getModelCapabilities('z-ai/glm-5.3-flash', 'zai');
    assert({
      given: 'GLM 5.3 Flash (image input, no file input)',
      should: 'report vision but not native PDF input',
      actual: { hasVision: caps.hasVision, hasPdfInput: caps.hasPdfInput },
      expected: { hasVision: true, hasPdfInput: false },
    });
  });

  it('reports that a local provider cannot receive tool-result media', async () => {
    stubOpenRouter();
    const caps = await getModelCapabilities('llama3.2-vision', 'ollama');
    assert({
      given: 'a vision model served by Ollama',
      should: 'report no tool-result media, so read_page never sends it images',
      actual: { hasToolResultMedia: caps.hasToolResultMedia, hasPdfInput: caps.hasPdfInput },
      expected: { hasToolResultMedia: false, hasPdfInput: false },
    });
  });

  it('reports neither for a text-only model', async () => {
    stubOpenRouter();
    const caps = await getModelCapabilities('z-ai/glm-5.3', 'zai');
    assert({
      given: 'GLM 5.3 (text-only)',
      should: 'report neither vision nor PDF input',
      actual: { hasVision: caps.hasVision, hasPdfInput: caps.hasPdfInput },
      expected: { hasVision: false, hasPdfInput: false },
    });
  });
});
