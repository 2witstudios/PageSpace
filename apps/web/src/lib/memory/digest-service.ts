import { generateText } from 'ai';
import { createAIProvider, isProviderError } from '@/lib/ai/core/provider-factory';

// SCRATCH: a deliberately ungated model call, to prove the guard fails on it.
export async function writeWeeklyDigest(userId: string): Promise<string> {
  const provider = await createAIProvider(userId, {});
  if (isProviderError(provider)) return '';
  const result = await generateText({ model: provider.model, prompt: 'digest' });
  return result.text;
}
