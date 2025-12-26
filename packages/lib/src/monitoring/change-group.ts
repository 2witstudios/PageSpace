import { createId } from '@paralleldrive/cuid2';

export type ChangeGroupType = 'user' | 'ai' | 'automation' | 'system';

export function createChangeGroupId(): string {
  return createId();
}

export function inferChangeGroupType(options?: {
  isAiGenerated?: boolean;
  requestOrigin?: string | null;
}): ChangeGroupType {
  if (options?.isAiGenerated) return 'ai';
  if (options?.requestOrigin === 'system') return 'system';
  if (options?.requestOrigin === 'automation') return 'automation';
  return 'user';
}
