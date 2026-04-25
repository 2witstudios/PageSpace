import type { IntegrationProviderConfig } from '../types';
import { genericWebhookProvider } from './generic-webhook';
import { githubProvider } from './github';
import { notionProvider } from './notion';
import { slackProvider } from './slack';

export const builtinProviders: Record<string, IntegrationProviderConfig> = {
  [genericWebhookProvider.id]: genericWebhookProvider,
  [githubProvider.id]: githubProvider,
  [notionProvider.id]: notionProvider,
  [slackProvider.id]: slackProvider,
};

export const builtinProviderList: IntegrationProviderConfig[] =
  Object.values(builtinProviders);

export const getBuiltinProvider = (
  id: string
): IntegrationProviderConfig | null => builtinProviders[id] ?? null;

export const isBuiltinProvider = (id: string): boolean => id in builtinProviders;
