export type OpenRouterModel = {
  id: string;
  name: string;
  pricing?: { prompt: string };
};

export const filterFreeModels = (models: OpenRouterModel[]): Record<string, string> =>
  Object.fromEntries(
    models
      .filter(m => m.id.endsWith(':free') && m.pricing?.prompt === '0')
      .map(m => [m.id, m.name])
  );
