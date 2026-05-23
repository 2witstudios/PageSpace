export type OpenRouterModel = {
  id: string;
  name: string;
  pricing?: { prompt: string };
};

export const filterFreeModels = (models: OpenRouterModel[]): Record<string, string> =>
  models
    .filter(m => m.id.endsWith(':free') && m.pricing?.prompt === '0')
    .reduce<Record<string, string>>((acc, m) => ({ ...acc, [m.id]: m.name }), {});
