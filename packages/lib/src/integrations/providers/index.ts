/**
 * Built-in Provider Registry
 *
 * Central registry of all built-in integration provider adapters.
 * Each adapter is a static IntegrationProviderConfig object — pure data.
 * The execution engine handles all runtime concerns.
 */

import type { IntegrationProviderConfig } from '../types';
import { genericWebhookProvider } from './generic-webhook';
import { githubProvider } from './github';
import { notionProvider } from './notion';

export { genericWebhookProvider } from './generic-webhook';
export { githubProvider } from './github';
export { notionProvider } from './notion';

export const builtinProviders: Record<string, IntegrationProviderConfig> = {
  [genericWebhookProvider.id]: genericWebhookProvider,
  [githubProvider.id]: githubProvider,
  [notionProvider.id]: notionProvider,
};

export const builtinProviderList: IntegrationProviderConfig[] =
  Object.values(builtinProviders);

export const getBuiltinProvider = (
  id: string
): IntegrationProviderConfig | null => builtinProviders[id] ?? null;

export const isBuiltinProvider = (id: string): boolean => id in builtinProviders;
